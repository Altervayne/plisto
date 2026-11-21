/*
 * Runs the transport stand-in against a visualizer frame: credits and coalescing over a 20 s run with a
 * consumer throttled to 30 fps, a second run with the consumer blocked 40 ms per frame, and the cost of a
 * post timed over batches of real-shaped ticks, since one post may be below the clock's resolution. The
 * round trip by ack is the primary latency; one-way latency compares clocks of two processes and is
 * reported as such. Beats and outstanding ticks are judged from what the frame itself counted, never from
 * numbers the sender wrote into its own ticks.
 */

// -- Local Imports --
import { mountProbeFrame } from "../frames";
import { watchSlot } from "../slotWatch";
import { fixed, maxOf, median, percentile } from "../stats";
import { awaitMessage, observeClockStep, timeBatches, TransportSender, waitMs } from "./transportStandIn";

// -- Type Imports --
import type { ProbeContext, ProbeModule, ProbeOutcome } from "../types";
import type { SenderStats, Tick } from "./transportStandIn";

const RUN_MS = 20_000;
const DRAIN_MS = 400;
const REPORT_WAIT_MS = 2000;
const BAND_COUNT = 128;
const BEAT_EVERY_MS = 500;
const COST_BATCHES = 30;
const COST_BATCH_SIZE = 100;
const MAX_POST_MS = 0.1;
const DT_TOLERANCE = 1e-6;
// A page frame that never arrives (a hidden window) must not hang the loop.
const FRAME_FALLBACK_MS = 100;
/** The fewest ticks a second a live 30 fps consumer, even one blocked 40 ms per frame, takes. */
export const MIN_TICKS_PER_SEC = 8;

export interface FrameTotals {
  received: number;
  beatsSeen: number;
  dtSum: number;
  consumed: number;
  /** Beats carried by the consumed ticks, summed from each tick's `nBeats` so coalesced ticks count all theirs. */
  beatsConsumed: number;
  consumedDt: number;
  /** The most ticks the frame saw outstanding at once, from its own acknowledgements. */
  maxBehind: number;
}

export interface RunResult {
  label: string;
  frames: number;
  seconds: number;
  sender: SenderStats;
  totals: FrameTotals | null;
  roundTrip: number[];
  oneWay: number[];
  /** Why the run cannot be judged: the page was hidden, or the loop ended short. Null when it can. */
  unusable: string | null;
}

/** A run shorter than this share of its length ended early. */
const SHORT_RUN = 0.95;

/** The next page frame, or a timestamp after a short wait when none is coming. */
function nextFrame(signal: AbortSignal): Promise<number> {
  return new Promise((resolve) => {
    let done = false;
    const end = (t: number) => {
      if (done) return;
      done = true;
      clearTimeout(timer);
      resolve(t);
    };
    const timer = setTimeout(() => end(performance.now()), FRAME_FALLBACK_MS);
    if (signal.aborted) return end(performance.now());
    requestAnimationFrame(end);
  });
}

/** A tick of the shape the runtime sends: about 1 KB of band data plus the scalar fields. */
function sampleTick(seq: number): Tick {
  return {
    type: "tick",
    seq,
    dt: 0.016,
    beat: 0,
    flux: 0.05,
    kick: 0,
    level: 0.5,
    nBeats: 0,
    sentEpoch: 0,
    bands: new Float32Array(BAND_COUNT).fill(0.25),
    raw: new Float32Array(BAND_COUNT).fill(0.5),
  };
}

/** What is wrong with one run, judged from the frame's own counts. Empty when nothing is. */
export function judgeRun(r: RunResult): string[] {
  const s = r.sender;
  const t = r.totals;
  const problems: string[] = [];
  if (s.beatsPending > 0) problems.push(`${r.label}: ${s.beatsPending} beats still pending after the drain, the consumer is starved`);
  const floor = Math.floor(r.seconds * MIN_TICKS_PER_SEC);
  if (s.ticks < floor) problems.push(`${r.label}: ${s.ticks} ticks sent in ${fixed(r.seconds, 1)} s, under the floor of ${floor} (${MIN_TICKS_PER_SEC} per second)`);
  if (r.roundTrip.length < floor) problems.push(`${r.label}: ${r.roundTrip.length} acks, under the floor of ${floor}`);
  if (!t) return problems;
  if (t.received !== s.ticks) problems.push(`${r.label}: the frame received ${t.received} of ${s.ticks} ticks`);
  if (Math.abs(t.dtSum - s.dtSent) > DT_TOLERANCE) problems.push(`${r.label}: the frame's dt differs from dt sent`);
  if (t.beatsConsumed !== s.beatsSent) {
    problems.push(`${r.label}: the frame consumed ${t.beatsConsumed} beats, not the ${s.beatsSent} beats sent`);
  }
  // What the frame consumed must account for everything sent: a consumer that stops late leaves dt, acks
  // or credits behind even when no beat falls in the gap.
  if (Math.abs(t.consumedDt - s.dtSent) > DT_TOLERANCE) {
    problems.push(`${r.label}: the frame consumed ${fixed(t.consumedDt, 4)} s of dt of ${fixed(s.dtSent, 4)} s sent`);
  }
  if (t.consumed !== r.roundTrip.length) problems.push(`${r.label}: the frame consumed ${t.consumed} ticks but ${r.roundTrip.length} acks came back`);
  if (s.outstanding !== 0) problems.push(`${r.label}: ${s.outstanding} ticks still unacknowledged after the drain`);
  return problems;
}

export interface TransportVerdict {
  state: "pass" | "fail" | "invalid";
  problems: string[];
}

/**
 * Invalid when a run could not be taken (page hidden, ended short) or has no frame report; else fail on
 * any problem or a post cost at or over the limit.
 */
export function judgeTransport(runs: readonly RunResult[], postMedianMs: number): TransportVerdict {
  const unusable = runs.filter((r) => r.unusable).map((r) => `${r.label}: ${r.unusable}`);
  if (unusable.length) return { state: "invalid", problems: unusable };
  const silent = runs.filter((r) => !r.totals).map((r) => `${r.label}: no report from the frame`);
  if (silent.length) return { state: "invalid", problems: silent };
  if (!Number.isFinite(postMedianMs)) return { state: "invalid", problems: ["the post cost is not a number"] };
  const problems = runs.flatMap(judgeRun);
  if (postMedianMs >= MAX_POST_MS) problems.push(`post cost median ${fixed(postMedianMs, 4)} ms is not under ${MAX_POST_MS} ms`);
  return { state: problems.length ? "fail" : "pass", problems };
}

async function creditRun(port: MessagePort, mode: "run" | "block", label: string, signal: AbortSignal): Promise<RunResult> {
  port.postMessage({ type: "reset" });
  port.postMessage({ type: "mode", mode });
  const sentAt = new Map<number, number>();
  const roundTrip: number[] = [];
  const oneWay: number[] = [];
  const sender = new TransportSender((tick) => {
    sentAt.set(tick.seq, performance.now());
    tick.sentEpoch = performance.timeOrigin + performance.now();
    port.postMessage(tick);
  });
  port.onmessage = (e: MessageEvent) => {
    const d = e.data as { type?: string; seq?: number; sentEpoch?: number; rxEpoch?: number } | null;
    if (d?.type !== "ack" || typeof d.seq !== "number") return;
    const sent = sentAt.get(d.seq);
    if (sent !== undefined) roundTrip.push(performance.now() - sent);
    if (typeof d.sentEpoch === "number" && typeof d.rxEpoch === "number") oneWay.push(d.rxEpoch - d.sentEpoch);
    for (const seq of sentAt.keys()) if (seq <= d.seq) sentAt.delete(seq);
    sender.ack(d.seq);
  };

  const bands = new Float32Array(BAND_COUNT).fill(0.25);
  const raw = new Float32Array(BAND_COUNT).fill(0.5);
  let frames = 0;
  let last = await nextFrame(signal);
  const start = last;
  let nextBeat = start;
  let hidden = document.hidden;
  while (last - start < RUN_MS && !signal.aborted) {
    const t = await nextFrame(signal);
    if (document.hidden) hidden = true;
    const beat = t >= nextBeat ? 1 : 0;
    if (beat) nextBeat += BEAT_EVERY_MS;
    sender.push({
      dt: (t - last) / 1000,
      beat,
      flux: frames % 15 === 0 ? 1 : 0.05,
      kick: beat ? 0.9 : 0,
      level: 0.5,
      bands,
      raw,
    });
    last = t;
    frames++;
  }
  const seconds = (last - start) / 1000;
  // One empty sample after the acks settle sends whatever the credit window was still holding back.
  await waitMs(DRAIN_MS, signal);
  sender.push({ dt: 0, beat: 0, flux: 0, kick: 0, level: 0.5, bands, raw });
  await waitMs(DRAIN_MS, signal);
  const report = await awaitMessage<{ type: string; totals: FrameTotals }>(port, "report", REPORT_WAIT_MS, signal, () =>
    port.postMessage({ type: "report" }),
  );
  port.onmessage = null;
  let unusable: string | null = null;
  if (hidden) unusable = "the page was hidden during the run, so its frame loop was not running";
  else if (!signal.aborted && seconds * 1000 < RUN_MS * SHORT_RUN) unusable = `the run ended after ${fixed(seconds, 1)} s of ${RUN_MS / 1000} s`;
  return { label, frames, seconds, sender: sender.stats(), totals: report?.totals ?? null, roundTrip, oneWay, unusable };
}

/** Post cost per tick: batches of real-shaped posts, with a pause between batches so the pipe drains. */
async function postCost(port: MessagePort, signal: AbortSignal): Promise<{ perPost: number[]; step: number }> {
  port.postMessage({ type: "mode", mode: "sink" });
  const ticks = Array.from({ length: COST_BATCH_SIZE }, (_, i) => sampleTick(i + 1));
  const perPost: number[] = [];
  for (let b = 0; b < COST_BATCHES && !signal.aborted; b++) {
    const timing = timeBatches(1, COST_BATCH_SIZE, (i) => port.postMessage(ticks[i]), () => performance.now());
    perPost.push(...timing.perItem);
    await waitMs(20, signal);
  }
  return { perPost, step: observeClockStep(() => performance.now()) };
}

function runLines(r: RunResult): string[] {
  const s = r.sender;
  const t = r.totals;
  return [
    `${r.label}: ${r.frames} page frames in ${fixed(r.seconds, 1)} s, ${s.ticks} ticks sent, ${s.samples - s.ticks} samples coalesced, outstanding at most ${t?.maxBehind ?? "n/a"} by the frame's count`,
    `${r.label}: beats generated ${s.beatsIn}, sent ${s.beatsSent}, pending ${s.beatsPending}; frame consumed ${t?.beatsConsumed ?? "n/a"} beats in ${t?.consumed ?? "n/a"} consumed ticks`,
    `${r.label}: dt in ${fixed(s.dtIn, 3)} s, sent ${fixed(s.dtSent, 3)} s, pending ${fixed(s.dtPending, 3)} s, frame received ${t ? fixed(t.dtSum, 3) : "n/a"} s`,
    `${r.label}: round trip (primary) median ${fixed(median(r.roundTrip), 2)} ms, p99 ${fixed(percentile(r.roundTrip, 99), 2)} ms, max ${fixed(maxOf(r.roundTrip), 2)} ms over ${r.roundTrip.length} acks`,
    `${r.label}: one-way median ${fixed(median(r.oneWay), 2)} ms, not comparable across processes (two clocks)`,
  ];
}

async function run(ctx: ProbeContext): Promise<ProbeOutcome> {
  const frame = await mountProbeFrame({
    host: "probe-vis",
    file: "vis-transport.html",
    parent: ctx.stages.subject.slot,
    signal: ctx.signal,
    width: "100%",
    height: "100%",
    borderless: true,
  });
  const watch = watchSlot(ctx.stages.subject.slot);
  try {
    const port = frame.port;
    if (document.hidden) return { state: "invalid", lines: ["the page is hidden, so its frame loop cannot run; show the window and run again"] };

    ctx.log("post cost");
    const cost = await postCost(port, ctx.signal);
    const costMedian = median(cost.perPost);
    const costP99 = percentile(cost.perPost, 99);
    port.postMessage({ type: "mode", mode: "run" });
    await waitMs(200, ctx.signal);

    ctx.log("credit run, consumer at 30 fps");
    const normal = await creditRun(port, "run", "consumer 30 fps", ctx.signal);
    ctx.log("credit run, consumer blocked 40 ms per frame");
    const blocked = await creditRun(port, "block", "consumer blocked 40 ms", ctx.signal);
    if (ctx.signal.aborted) return { state: "invalid", lines: ["stopped"] };

    if (watch.leftView) return { state: "invalid", lines: [watch.note] };
    const verdict = judgeTransport([normal, blocked], costMedian);
    const lines = [
      `post cost median ${fixed(costMedian, 4)} ms per post, p99 of batch means ${fixed(costP99, 4)} ms, over ${COST_BATCHES} batches of ${COST_BATCH_SIZE}; clock step observed ${fixed(cost.step, 4)} ms`,
      ...runLines(normal),
      ...runLines(blocked),
    ];
    return { state: verdict.state, lines: [...verdict.problems, ...lines] };
  } finally {
    watch.stop();
    frame.unmount();
  }
}

export const probe: ProbeModule = {
  id: "P6",
  run,
  timeoutMs: 90_000,
};
