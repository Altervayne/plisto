/*
 * The liveness state machine of one plugin frame. Pure: every function takes the clock as an argument
 * and returns a new state, so the timeline is testable without timers. The clock runs from mount, so a
 * frame whose document never finishes loading still crashes.
 */

/** How often a ping goes out, in ms. */
export const PING_MS = 1000;

/** Silence after which the frame reads as not responding, in ms. */
export const NOT_RESPONDING_MS = 5000;

/** Silence after which the frame reads as crashed, in ms. */
export const CRASH_MS = 15000;

export type HeartbeatPhase = "loading" | "live" | "not_responding" | "crashed";

export interface Heartbeat {
  phase: HeartbeatPhase;
  /** The last moment the frame was known alive (mount, a pong, a grace or a wait). */
  lastAlive: number;
  /** The seq of the last ping sent. */
  seq: number;
  /** The seq of the last pong accepted. */
  lastPongSeq: number;
  /** Whether a pong was ever accepted. */
  everAlive: boolean;
  /** True while the main document is hidden; the clock does not run. */
  paused: boolean;
}

export function start(now: number): Heartbeat {
  return { phase: "loading", lastAlive: now, seq: 0, lastPongSeq: 0, everAlive: false, paused: false };
}

/**
 * Advances the clock. A ping is emitted only once the frame's document has loaded; the silence checks
 * run regardless. A paused or crashed machine does nothing.
 */
export function tick(
  hb: Heartbeat,
  now: number,
  loaded: boolean,
): { hb: Heartbeat; ping: number | null } {
  if (hb.paused || hb.phase === "crashed") return { hb, ping: null };
  const silent = now - hb.lastAlive;
  let phase: HeartbeatPhase = hb.phase;
  if (silent >= CRASH_MS) phase = "crashed";
  else if (silent >= NOT_RESPONDING_MS) phase = "not_responding";
  if (phase === "crashed") return { hb: { ...hb, phase }, ping: null };
  if (!loaded) return { hb: { ...hb, phase }, ping: null };
  const seq = hb.seq + 1;
  return { hb: { ...hb, phase, seq }, ping: seq };
}

/** Accepts a pong only for a ping already sent and not already answered. */
export function pong(hb: Heartbeat, seq: number, now: number): Heartbeat {
  if (hb.phase === "crashed" || !(hb.lastPongSeq < seq && seq <= hb.seq)) return hb;
  return { ...hb, lastPongSeq: seq, lastAlive: now, everAlive: true, phase: "live" };
}

export function hide(hb: Heartbeat): Heartbeat {
  return { ...hb, paused: true };
}

/** Resumes with a fresh silence budget, so a long hidden spell never reads as silence. */
export function show(hb: Heartbeat, now: number): Heartbeat {
  return { ...hb, paused: false, lastAlive: now };
}

/** The user chose to wait: both silence clocks restart from now. */
export function wait(hb: Heartbeat, now: number): Heartbeat {
  if (hb.phase === "crashed") return hb;
  return { ...hb, lastAlive: now, phase: hb.everAlive ? "live" : "loading" };
}
