/*
 * Measures how often a cross-origin frame's requestAnimationFrame fires while its slot is at full
 * opacity, held at opacity 0, and driven through the visualizer dip. The page samples the frame's running
 * callback count over its port, so no timer inside the frame is involved.
 */

// -- State Imports --
import { createDip, dipOpacity, stepDip } from "../../../state/player/visualizerDip";
import type { VisualizerKind } from "../../../state/player/visualizerKind";

// -- Local Imports --
import { mountProbeFrame } from "../frames";
import { fixed } from "../stats";
import { waitMs } from "./transportStandIn";

// -- Type Imports --
import type { ProbeContext, ProbeModule, ProbeOutcome } from "../types";

const SAMPLE_MS = 250;
const REPLY_TIMEOUT_MS = 1000;
const FULL_MS = 3000;
const HELD_MS = 5000;
const DIP_MS = 6000;
// Below this opacity an interval counts as the low part of the dip.
const LOW_OPACITY = 0.1;

const MINIMIZE_MS = 9000;

const PHASES = [
  "opacity 1",
  "opacity 0",
  "dip, opacity under 0.1",
  "dip, opacity 0.1 and up",
  "minimize step, page visible",
  "page hidden",
] as const;

interface Reply {
  count: number;
  now: number;
}

interface Sample {
  phase: string;
  reply: Reply | null;
}

/** Asks the frame for its running callback count; a missing answer, or a stop, reads as null. */
function makeAsker(port: MessagePort, signal: AbortSignal): () => Promise<Reply | null> {
  const waiting = new Map<number, (reply: Reply) => void>();
  let next = 0;
  port.onmessage = (e: MessageEvent) => {
    const d = e.data as { type?: string; id?: number; count?: number; now?: number } | null;
    if (d?.type === "sample" && typeof d.id === "number") {
      waiting.get(d.id)?.({ count: Number(d.count), now: Number(d.now) });
    }
  };
  return () =>
    new Promise((resolve) => {
      if (signal.aborted) return resolve(null);
      const id = next++;
      const end = (reply: Reply | null) => {
        clearTimeout(timer);
        signal.removeEventListener("abort", onAbort);
        waiting.delete(id);
        resolve(reply);
      };
      const onAbort = () => end(null);
      const timer = setTimeout(() => end(null), REPLY_TIMEOUT_MS);
      signal.addEventListener("abort", onAbort, { once: true });
      waiting.set(id, end);
      port.postMessage({ type: "sample", id });
    });
}

interface Rate {
  count: number;
  ms: number;
  intervals: number;
  silent: number;
}

/** Sums callbacks and frame time over consecutive replies that share a phase. */
function ratesByPhase(samples: readonly Sample[]): Map<string, Rate> {
  const rates = new Map<string, Rate>();
  for (let i = 1; i < samples.length; i++) {
    const prev = samples[i - 1];
    const cur = samples[i];
    if (!prev.reply || !cur.reply || prev.phase !== cur.phase) continue;
    const ms = cur.reply.now - prev.reply.now;
    if (ms <= 0) continue;
    const count = cur.reply.count - prev.reply.count;
    const rate = rates.get(cur.phase) ?? { count: 0, ms: 0, intervals: 0, silent: 0 };
    rate.count += count;
    rate.ms += ms;
    rate.intervals++;
    if (count === 0) rate.silent++;
    rates.set(cur.phase, rate);
  }
  return rates;
}

async function run(ctx: ProbeContext): Promise<ProbeOutcome> {
  const stage = ctx.stages.subject;
  const frame = await mountProbeFrame({
    host: "probe-vis",
    file: "vis-raf.html",
    parent: stage.slot,
    signal: ctx.signal,
    width: "100%",
    height: "100%",
    borderless: true,
  });
  try {
    const ask = makeAsker(frame.port, ctx.signal);
    const samples: Sample[] = [];
    let opacity = 1;
    stage.setDip(1);

    const collect = async (ms: number, phaseOf: () => string) => {
      const end = performance.now() + ms;
      while (performance.now() < end && !ctx.signal.aborted) {
        await waitMs(SAMPLE_MS, ctx.signal);
        if (ctx.signal.aborted) return;
        const phase = document.hidden ? "page hidden" : phaseOf();
        samples.push({ phase, reply: await ask() });
      }
    };

    // The dip runs on the real curve: each page frame steps it and sets the slot's opacity.
    // A timer ends it too: a hidden window delivers no frames, and the run must still finish.
    const driveDip = (ms: number) =>
      new Promise<void>((resolve) => {
        let state = createDip("ridge");
        let target: VisualizerKind = "lake";
        let last = performance.now();
        const end = last + ms;
        let over = false;
        void waitMs(ms, ctx.signal).then(() => {
          over = true;
          resolve();
        });
        const tick = (t: number) => {
          if (over || ctx.signal.aborted || t >= end) return resolve();
          const dt = Math.max(0, (t - last) / 1000);
          last = t;
          state = stepDip(state, { target, ready: true, reason: "boundary", reduced: false }, dt).state;
          if (state.shown === target && state.p === 1) target = target === "lake" ? "ridge" : "lake";
          opacity = dipOpacity(state);
          stage.setDip(opacity);
          requestAnimationFrame(tick);
        };
        requestAnimationFrame(tick);
      });

    ctx.log("opacity 1");
    await collect(FULL_MS, () => "opacity 1");
    ctx.log("opacity 0");
    stage.setDip(0);
    opacity = 0;
    await collect(HELD_MS, () => "opacity 0");
    ctx.log("dip");
    await Promise.all([
      driveDip(DIP_MS),
      collect(DIP_MS, () => (opacity < LOW_OPACITY ? "dip, opacity under 0.1" : "dip, opacity 0.1 and up")),
    ]);

    const answer = await ctx.ask("Minimize the window for 5 seconds, then restore it.");
    const extra: string[] = [];
    if (answer === "continue") {
      ctx.log("minimize step");
      stage.setDip(1);
      opacity = 1;
      await collect(MINIMIZE_MS, () => "minimize step, page visible");
      if (!samples.some((s) => s.phase === "page hidden")) extra.push("minimize step: the page was never seen hidden");
    } else {
      extra.push("minimize step skipped");
    }

    if (ctx.signal.aborted) return { state: "invalid", lines: ["stopped"] };
    const rates = ratesByPhase(samples);
    const lines = PHASES.filter((p) => rates.has(p)).map((p) => {
      const r = rates.get(p) as Rate;
      return `${p}: ${fixed((r.count / r.ms) * 1000)} callbacks/s over ${r.intervals} intervals of ${SAMPLE_MS} ms, ${r.silent} with none`;
    });
    lines.push(...extra);
    const unanswered = samples.filter((s) => !s.reply).length;
    if (unanswered > 0) lines.push(`${unanswered} of ${samples.length} samples got no reply within ${REPLY_TIMEOUT_MS} ms`);
    if (!rates.has("opacity 1")) {
      return { state: "invalid", lines: ["no usable interval at opacity 1", ...lines] };
    }
    return { state: "measured", lines };
  } finally {
    stage.setDip(1);
    frame.unmount();
  }
}

export const probe: ProbeModule = {
  id: "P5",
  run,
  // The fixed phases, the 30 s prompt wait and the 9 s minimize step.
  timeoutMs: 90_000,
};
