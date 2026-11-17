/*
 * P3: where frames run and what a busy one does to the page. A heartbeat frame on the UI host answers
 * pings while a frame on the visualizer host spins (once on its main thread, once in a blob worker). The
 * probe reads process placement from the process list, the pong latency and the page's longest frame gap
 * during each spin, CPU per process, whether the spinning host's processes leave after unmount, and, for
 * one that does not, whether the guarded terminate ends it while the heartbeat keeps answering.
 * The pure parts (placement, the pids the page may offer, the verdict) are exported for tests; the
 * frame and process helpers are shared with the other probes that mount frames.
 */

// -- Local Imports --
import { mountProbeFrame } from "../frames";
import { probeCpu, probeProcesses, probeTerminate } from "../ipc";
import { fixed, maxOf, median } from "../stats";

// -- Type Imports --
import type { MountedFrame, ProbeHost } from "../frames";
import type { ProbeProcess } from "../ipc";
import type { OutcomeState, ProbeModule, ProbeOutcome } from "../types";

// ---- Process lookup ----

const PROBE_HOST = /^https:\/\/(probe-[a-z0-9]+)\.invalid$/;
const APP_HOST = /^https?:\/\/(localhost|tauri\.localhost)$/;
const HEARTBEAT_LABEL = "probe-ui1";

/** The probe host label (`probe-vis`) a process frame host names, or null for any other host. */
export function probeLabel(host: string): string | null {
  return PROBE_HOST.exec(host)?.[1] ?? null;
}

/** The renderer pids serving at least one frame on the probe host `label`. */
export function pidsServing(list: readonly ProbeProcess[], label: string): number[] {
  return list.filter((p) => p.kind === "renderer" && p.hosts.some((h) => probeLabel(h) === label)).map((p) => p.pid);
}

/** The renderer pids serving the app's own document. */
export function pagePids(list: readonly ProbeProcess[]): number[] {
  return list.filter((p) => p.kind === "renderer" && p.hosts.some((h) => APP_HOST.test(h))).map((p) => p.pid);
}

/**
 * The pids the page may ask the host to end: a renderer whose frames are all on probe hosts, or a
 * frameless renderer that was seen serving a probe host earlier. A renderer that also serves the
 * heartbeat frame is never offered, since the check that the heartbeat survives depends on it; one that
 * serves the app's own document fails the all-probe-hosts rule.
 */
export function terminablePids(list: readonly ProbeProcess[], seenProbe: ReadonlySet<number>): number[] {
  return list
    .filter((p) => {
      if (p.kind !== "renderer") return false;
      if (p.hosts.length === 0) return seenProbe.has(p.pid);
      if (p.hosts.some((h) => probeLabel(h) === HEARTBEAT_LABEL)) return false;
      return p.hosts.every((h) => probeLabel(h) !== null);
    })
    .map((p) => p.pid);
}

/**
 * Whether two pid sets are disjoint: true when they share nothing, false when they share a pid, and null
 * when either is empty, since nothing was observed to compare.
 */
export function separation(a: readonly number[], b: readonly number[]): boolean | null {
  if (a.length === 0 || b.length === 0) return null;
  return !a.some((pid) => b.includes(pid));
}

const yesNoUnknown = (v: boolean | null) => (v === null ? "unknown" : v ? "yes" : "no");

// ---- Frames and timing helpers ----

const ABORTED = "aborted";

export function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(new Error(ABORTED));
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new Error(ABORTED));
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

/** Settles with `work`, or rejects as soon as `signal` aborts, for calls that cannot be cancelled. */
export function abortable<T>(work: Promise<T>, signal: AbortSignal): Promise<T> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return reject(new Error(ABORTED));
    const onAbort = () => reject(new Error(ABORTED));
    signal.addEventListener("abort", onAbort, { once: true });
    work.then(resolve, reject).finally(() => signal.removeEventListener("abort", onAbort));
  });
}

/** Mounts a probe frame filling `parent`, so it draws and receives animation frames like a visualizer. */
export async function mountFilling(
  parent: HTMLElement,
  host: ProbeHost,
  file: string,
  signal: AbortSignal,
): Promise<MountedFrame> {
  const frame = await mountProbeFrame({ host, file, parent, signal, width: "100%", height: "100%", borderless: true });
  Object.assign(frame.el.style, { position: "absolute", left: "0", top: "0" });
  return frame;
}

/** The next message of `type` on `port`, or a rejection after `ms` or on abort. */
export function waitFor(
  port: MessagePort,
  type: string,
  ms: number,
  signal: AbortSignal,
): Promise<Record<string, unknown>> {
  return new Promise((resolve, reject) => {
    const done = () => {
      clearTimeout(timer);
      port.removeEventListener("message", onMessage);
      signal.removeEventListener("abort", onAbort);
    };
    const onMessage = (e: MessageEvent) => {
      const data = e.data as Record<string, unknown> | null;
      if (data?.type !== type) return;
      done();
      resolve(data);
    };
    const onAbort = () => {
      done();
      reject(new Error(ABORTED));
    };
    const timer = setTimeout(() => {
      done();
      reject(new Error(`no ${type} message within ${ms} ms`));
    }, ms);
    if (signal.aborted) return onAbort();
    signal.addEventListener("abort", onAbort, { once: true });
    port.addEventListener("message", onMessage);
    port.start();
  });
}

export interface Heartbeat {
  /** Round trips in ms, with the page time each pong arrived. */
  readonly samples: ReadonlyArray<{ at: number; ms: number }>;
  readonly sent: number;
  stop(): void;
}

/** Pings `port` every `intervalMs` and times each pong against the page's own send stamp. */
export function startHeartbeat(port: MessagePort, intervalMs: number): Heartbeat {
  const samples: { at: number; ms: number }[] = [];
  let sent = 0;
  const onMessage = (e: MessageEvent) => {
    const data = e.data as { type?: string; sent?: number } | null;
    if (data?.type !== "pong" || typeof data.sent !== "number") return;
    const at = performance.now();
    samples.push({ at, ms: at - data.sent });
  };
  port.addEventListener("message", onMessage);
  port.start();
  const timer = setInterval(() => {
    sent += 1;
    port.postMessage({ type: "ping", seq: sent, sent: performance.now() });
  }, intervalMs);
  return {
    samples,
    get sent() {
      return sent;
    },
    stop() {
      clearInterval(timer);
      port.removeEventListener("message", onMessage);
    },
  };
}

/**
 * Whether a pong arrived for a ping sent at or after `t`: a pong already in flight when the process was
 * ended proves nothing about the heartbeat afterwards.
 */
export function answeredAfter(samples: ReadonlyArray<{ at: number; ms: number }>, t: number): boolean {
  return samples.some((s) => s.at - s.ms >= t);
}

/** The longest frame gap of a watch: the closed gaps seen, or the interval still open at `now` if longer. */
export function longestGap(closed: number, lastFrameAt: number, now: number): number {
  return Math.max(closed, now - lastFrameAt);
}

/**
 * Tracks the longest gap between animation frames of the page, how many frames fired, and whether the
 * page was ever hidden. The interval still open when `stop` is called counts, so a page that drew
 * nothing reads as one long gap, not zero.
 */
export function watchFrameGaps(): { stop(): number; frames(): number; wasHidden(): boolean } {
  let last = performance.now();
  let longest = 0;
  let count = 0;
  let hidden = document.hidden;
  const onVisibility = () => {
    if (document.hidden) hidden = true;
  };
  document.addEventListener("visibilitychange", onVisibility);
  let raf = requestAnimationFrame(function tick(now) {
    longest = Math.max(longest, now - last);
    last = now;
    count += 1;
    if (document.hidden) hidden = true;
    raf = requestAnimationFrame(tick);
  });
  return {
    stop() {
      cancelAnimationFrame(raf);
      document.removeEventListener("visibilitychange", onVisibility);
      return longestGap(longest, last, performance.now());
    },
    frames: () => count,
    wasHidden: () => hidden,
  };
}

// ---- Verdict ----

/** The longest pong round trip or frame gap, in ms, the page may show while a frame spins. */
export const ANSWER_LIMIT_MS = 250;
/** The share of pings that must be answered. */
export const ANSWER_RATIO = 0.9;

export interface P3Facts {
  /** True when the page was hidden or minimized at any point of a spin: frame gaps then say nothing about the frames. */
  hidden: boolean;
  /** Null when the worker variant ran; otherwise why it did not. */
  workerNote: string | null;
  /** The renderer pids serving the page, the heartbeat frame and the busy visualizer frames. */
  pagePids: number[];
  heartbeatPids: number[];
  busyPids: number[];
  /** The longest pong round trip and frame gap seen while a frame spun, over both variants. */
  pongMaxMs: number;
  frameGapMaxMs: number;
  /** Animation frames the page drew while a frame spun; none means the gap reading is empty. */
  pageFrames: number;
  /** Pings sent and pongs received over both variants. */
  pingsSent: number;
  pongsReceived: number;
  /** Renderer pids still listed 10 s after the visualizer-host frames were removed. */
  stuck: number[];
  /** True when every stuck pid was ended through the guarded terminate, left the list, and the heartbeat kept answering. */
  remedyWorked: boolean;
}

/** The verdict of P3 and the reasons behind it. */
export function p3Verdict(f: P3Facts): { state: OutcomeState; reasons: string[] } {
  if (f.hidden) {
    return { state: "invalid", reasons: ["the window was hidden or minimized during a spin: frame timing is not comparable"] };
  }
  // Every separation the pass line claims must be positively known: an empty set proves nothing.
  const unknown = [
    f.pagePids.length === 0 ? "the page's own process" : null,
    f.busyPids.length === 0 ? "the busy visualizer frame's process" : null,
    f.heartbeatPids.length === 0 ? "the heartbeat frame's process" : null,
  ].filter((s): s is string => s !== null);
  if (unknown.length > 0) {
    return { state: "invalid", reasons: [`no frame-to-process mapping: the process list does not show ${unknown.join(", ")}`] };
  }
  if (f.pageFrames === 0) {
    return { state: "invalid", reasons: ["no animation frame fired in the page during a spin, so its frame gap was not measured"] };
  }
  const reasons: string[] = [];
  if (separation(f.busyPids, f.heartbeatPids) === false) reasons.push("a busy frame shares a process with the heartbeat frame");
  if (separation(f.busyPids, f.pagePids) === false) reasons.push("a busy frame shares a process with the page");
  if (f.pongsReceived < f.pingsSent * ANSWER_RATIO) reasons.push(`heartbeat answered ${f.pongsReceived} of ${f.pingsSent} pings`);
  if (f.pongMaxMs > ANSWER_LIMIT_MS) reasons.push(`heartbeat round trip reached ${fixed(f.pongMaxMs, 0)} ms`);
  if (f.frameGapMaxMs > ANSWER_LIMIT_MS) reasons.push(`page frame gap reached ${fixed(f.frameGapMaxMs, 0)} ms`);
  if (f.stuck.length > 0 && !f.remedyWorked) reasons.push(`pid ${f.stuck.join(", ")} stayed after unmount and no remedy ended it`);
  if (reasons.length > 0) {
    return { state: "fail", reasons: f.workerNote ? [...reasons, `worker variant not measured: ${f.workerNote}`] : reasons };
  }
  if (f.workerNote) return { state: "invalid", reasons: [`worker variant not measured: ${f.workerNote}`] };
  return { state: "pass", reasons: [] };
}

// ---- The probe ----

const HEARTBEAT_MS = 100;
const BUSY_MS = 10_000;
const CPU_AFTER_MS = 2_000;
const CPU_WINDOW_MS = 5_000;
// The CPU window opens CPU_AFTER_MS into a spin, so a spin must outlast both.
const WORKER_BUSY_MS = CPU_AFTER_MS + CPU_WINDOW_MS + 2_000;
const EXIT_WAIT_MS = 10_000;
const EXIT_POLL_MS = 500;
const TERMINATE_GONE_MS = 3_000;
const UI_HOST: ProbeHost = "probe-ui1";
const VIS_HOST: ProbeHost = "probe-vis";
const VIS2_HOST: ProbeHost = "probe-vis2";

const idList = (pids: readonly number[]) => (pids.length ? pids.join(",") : "none");

interface Spin {
  pong: number[];
  sent: number;
  gapMs: number;
  frames: number;
  hidden: boolean;
  cpu: string;
}

/** One spin: heartbeat and frame gaps are read while `busy` runs, CPU over a window inside it. */
async function spin(
  busy: MountedFrame,
  hb: MountedFrame,
  ms: number,
  cpuPids: number[],
  signal: AbortSignal,
): Promise<Spin> {
  const beat = startHeartbeat(hb.port, HEARTBEAT_MS);
  const gaps = watchFrameGaps();
  try {
    const started = waitFor(busy.port, "busy-start", 5000, signal);
    const ended = waitFor(busy.port, "busy-end", ms + 10_000, signal);
    // A worker the host refuses reports instead of starting, or after starting; either way it ends the spin.
    let refusal: string | null = null;
    const refused = waitFor(busy.port, "worker-error", ms + 10_000, signal).then(
      (m) => {
        refusal = String(m.message);
        throw new Error(`worker refused: ${refusal}`);
      },
      () => new Promise<never>(() => {}),
    );
    started.catch(() => {});
    ended.catch(() => {});
    refused.catch(() => {});
    busy.port.postMessage({ type: "busy", ms });
    await Promise.race([started, refused]);
    await sleep(CPU_AFTER_MS, signal);
    const cpu = await abortable(probeCpu(cpuPids, CPU_WINDOW_MS), signal).catch((e) => {
      if (signal.aborted) throw e;
      return [];
    });
    await Promise.race([ended, refused]).catch((e) => {
      throw refusal !== null ? new Error(`worker refused: ${refusal}`) : e;
    });
    await sleep(300, signal);
    return {
      pong: beat.samples.map((s) => s.ms),
      sent: beat.sent,
      gapMs: gaps.stop(),
      frames: gaps.frames(),
      hidden: gaps.wasHidden(),
      // A pid the host could not read is left out of its answer; it is a reading, not a failure.
      cpu: cpuPids
        .map((pid) => {
          const sample = cpu.find((c) => c.pid === pid);
          return sample ? `${pid} ${fixed(sample.percent_of_one_core, 0)}%` : `${pid} unreadable`;
        })
        .join(", "),
    };
  } finally {
    beat.stop();
    gaps.stop();
  }
}

function spinLine(label: string, s: Spin): string {
  return `${label}: pongs ${s.pong.length}/${s.sent}, round trip median ${fixed(median(s.pong))} max ${fixed(maxOf(s.pong))} ms; page frame gap max ${fixed(s.gapMs)} ms; cpu ${s.cpu}`;
}

async function exitWait(pids: number[], signal: AbortSignal): Promise<{ left: number[]; exitedMs: number | null }> {
  const t0 = performance.now();
  let left = pids;
  while (performance.now() - t0 < EXIT_WAIT_MS) {
    const { processes } = await abortable(probeProcesses(), signal);
    left = pids.filter((pid) => processes.some((p) => p.pid === pid));
    if (left.length === 0) return { left, exitedMs: performance.now() - t0 };
    await sleep(EXIT_POLL_MS, signal);
  }
  return { left, exitedMs: null };
}

/** Ends each stuck pid the fresh list offers, then checks it left the list and the heartbeat still answers. */
async function remedy(
  stuck: number[],
  seenProbe: ReadonlySet<number>,
  hb: MountedFrame,
  signal: AbortSignal,
  lines: string[],
): Promise<boolean> {
  let worked = true;
  for (const pid of stuck) {
    const fresh = await abortable(probeProcesses(), signal);
    if (!terminablePids(fresh.processes, seenProbe).includes(pid)) {
      lines.push(`terminate pid ${pid}: not offered (no probe-only renderer in the fresh list, or it also serves the heartbeat frame)`);
      worked = false;
      continue;
    }
    const beat = startHeartbeat(hb.port, HEARTBEAT_MS);
    try {
      await abortable(probeTerminate(pid), signal);
      // Pings sent from here on are the ones that prove the heartbeat survived.
      const after = performance.now();
      let gone = false;
      while (!gone && performance.now() - after < TERMINATE_GONE_MS) {
        await sleep(EXIT_POLL_MS, signal);
        gone = !(await abortable(probeProcesses(), signal)).processes.some((p) => p.pid === pid);
      }
      const answered = answeredAfter(beat.samples, after);
      lines.push(`terminate pid ${pid}: ended, left the list: ${gone ? "yes" : "no"}, heartbeat answered after: ${answered ? "yes" : "no"}`);
      worked = worked && gone && answered;
    } catch (e) {
      if (signal.aborted) throw e;
      lines.push(`terminate pid ${pid}: no remedy available here (${e instanceof Error ? e.message : String(e)})`);
      worked = false;
    } finally {
      beat.stop();
    }
  }
  return worked;
}

async function run(ctx: Parameters<ProbeModule["run"]>[0]): Promise<ProbeOutcome> {
  const slot = ctx.stages.subject.slot;
  ctx.stages.subject.setBlend("normal");
  ctx.stages.subject.setDip(1);
  const frames: MountedFrame[] = [];
  const lines: string[] = [];
  const seenProbe = new Set<number>();
  if (document.hidden) return { state: "invalid", lines: ["the window is hidden or minimized: bring it forward and run again"] };
  try {
    ctx.log("mounting frames");
    const mount = async (host: ProbeHost, file: string) => {
      const frame = await mountFilling(slot, host, file, ctx.signal);
      frames.push(frame);
      return frame;
    };
    const hb = await mount(UI_HOST, "page-heartbeat.html");
    const busy = await mount(VIS_HOST, "vis-busy.html");
    await mount(VIS_HOST, "vis-busy.html");
    await mount(VIS2_HOST, "vis-busy.html");

    let list: ProbeProcess[];
    try {
      list = (await abortable(probeProcesses(), ctx.signal)).processes;
    } catch (e) {
      if (ctx.signal.aborted) throw e;
      return { state: "invalid", lines: [`process list unavailable: ${e instanceof Error ? e.message : String(e)}`] };
    }
    const hbPids = pidsServing(list, UI_HOST);
    const visPids = pidsServing(list, VIS_HOST);
    const vis2Pids = pidsServing(list, VIS2_HOST);
    const page = pagePids(list);
    visPids.forEach((p) => seenProbe.add(p));
    const sameShare = visPids.length === 0 ? null : visPids.length === 1;
    lines.push(
      `pids: page ${idList(page)}; ${UI_HOST} ${idList(hbPids)}; ${VIS_HOST} ${idList(visPids)}; ${VIS2_HOST} ${idList(vis2Pids)}`,
    );
    lines.push(
      `two frames on ${VIS_HOST} share one process: ${yesNoUnknown(sameShare)}; ${VIS2_HOST} separate from ${VIS_HOST}: ${yesNoUnknown(separation(vis2Pids, visPids))}; ${VIS_HOST} separate from ${UI_HOST}: ${yesNoUnknown(separation(visPids, hbPids))}`,
    );

    ctx.log("main-thread spin, 10 s");
    const cpuPids = [...new Set([...page, ...visPids, ...hbPids])].slice(0, 16);
    const main = await spin(busy, hb, BUSY_MS, cpuPids, ctx.signal);
    lines.push(spinLine("main-thread spin", main));

    ctx.log(`worker spin, ${WORKER_BUSY_MS / 1000} s`);
    for (const frame of frames.filter((f) => f !== hb)) frame.unmount();
    let workerSpin: Spin | null = null;
    let workerNote: string | null = null;
    try {
      const worker = await mount(VIS_HOST, "vis-busy-worker.html");
      const workerPids = pidsServing((await abortable(probeProcesses(), ctx.signal)).processes, VIS_HOST);
      workerPids.forEach((p) => seenProbe.add(p));
      workerSpin = await spin(worker, hb, WORKER_BUSY_MS, [...new Set([...page, ...workerPids])].slice(0, 16), ctx.signal);
      lines.push(spinLine("worker spin", workerSpin));
    } catch (e) {
      if (ctx.signal.aborted) throw e;
      workerNote = e instanceof Error ? e.message : String(e);
      lines.push(`worker spin: ${workerNote}`);
    }

    ctx.log("unmounting, waiting for exit");
    const tracked = [...seenProbe];
    for (const frame of frames.filter((f) => f !== hb)) frame.unmount();
    const exit = await exitWait(tracked, ctx.signal);
    lines.push(
      exit.exitedMs === null
        ? `after unmount: pid ${idList(exit.left)} still listed after ${EXIT_WAIT_MS / 1000} s`
        : `after unmount: ${VIS_HOST} process left the list after ${fixed(exit.exitedMs, 0)} ms`,
    );

    let remedyWorked = true;
    if (exit.left.length > 0) {
      ctx.log("ending the stuck process");
      remedyWorked = await remedy(exit.left, seenProbe, hb, ctx.signal, lines);
    }

    const spins = workerSpin ? [main, workerSpin] : [main];
    const verdict = p3Verdict({
      hidden: spins.some((s) => s.hidden),
      workerNote,
      pagePids: page,
      heartbeatPids: hbPids,
      busyPids: visPids,
      pongMaxMs: maxOf(spins.flatMap((s) => s.pong)),
      frameGapMaxMs: maxOf(spins.map((s) => s.gapMs)),
      pageFrames: Math.min(...spins.map((s) => s.frames)),
      pingsSent: spins.reduce((n, s) => n + s.sent, 0),
      pongsReceived: spins.reduce((n, s) => n + s.pong.length, 0),
      stuck: exit.left,
      remedyWorked,
    });
    lines.push(
      verdict.state === "pass"
        ? exit.left.length > 0
          ? "remedy exists: the guarded terminate ended the stuck process"
          : "no remedy needed: the process left on its own"
        : `reasons: ${verdict.reasons.join("; ")}`,
    );
    return { state: verdict.state, lines };
  } finally {
    for (const frame of frames) frame.unmount();
  }
}

export const probe: ProbeModule = { id: "P3", run, timeoutMs: 120_000 };
