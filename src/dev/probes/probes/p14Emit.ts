/*
 * Measures the cost of a burst of synthetic events from Rust to the page. Rust times each emit; the page
 * records each arrival and reports, per pair of received events, the arrival interval minus the send
 * interval, which is the jitter delivery adds and does not depend on pacing or on a clock offset.
 */

// -- Library Imports --
import { listen } from "@tauri-apps/api/event";

// -- Local Imports --
import { probeEmitBurst } from "../ipc";
import { clockStep, fixed, maxOf, median, percentile } from "../stats";
import { orAbort, waitMs } from "./transportStandIn";

// -- Type Imports --
import type { ProbeContext, ProbeModule, ProbeOutcome } from "../types";

const EVENT = "probe:burst";
const HZ = 30;
const BYTES = 1024;
const SECS = 10;
const MAX_EMIT_US = 100;
const TAIL_MS = 500;

interface BurstEvent {
  seq: number;
  sent_ns: number;
}

export interface BurstReading {
  medianUs: number;
  /** Emits Rust says it made. */
  count: number;
  /** The sequence number of every event the page received, in arrival order. */
  seqs: readonly number[];
  /** Emits a full burst makes. */
  expected: number;
}

const NAMED_MAX = 5;

function named(values: readonly number[]): string {
  const shown = values.slice(0, NAMED_MAX).join(", ");
  return values.length > NAMED_MAX ? `${shown} and ${values.length - NAMED_MAX} more` : shown;
}

/**
 * Compares the received sequence numbers with exactly one event for each of `count` consecutive numbers
 * starting at 0 or 1. Returns what differs, empty when delivery is exact.
 */
export function seqProblems(seqs: readonly number[], count: number): string[] {
  const start = seqs.includes(0) ? 0 : 1;
  const times = new Map<number, number>();
  for (const s of seqs) times.set(s, (times.get(s) ?? 0) + 1);
  const duplicates = [...times].filter(([, n]) => n > 1).map(([s]) => s);
  const strays = [...times.keys()].filter((s) => s < start || s >= start + count);
  const missing: number[] = [];
  for (let s = start; s < start + count; s++) if (!times.has(s)) missing.push(s);
  const problems: string[] = [];
  if (seqs.length !== count) problems.push(`the page received ${seqs.length} events for ${count} sent`);
  if (duplicates.length) problems.push(`duplicates: ${named(duplicates)}`);
  if (strays.length) problems.push(`stray sequence numbers: ${named(strays)}`);
  if (missing.length) problems.push(`missing: ${named(missing)}`);
  return problems;
}

/**
 * Invalid when Rust's burst was cut short or nothing arrived, fail when the received sequence is not
 * exactly the burst's or the median emit time is not under the limit, else pass.
 */
export function judgeBurst(r: BurstReading): { state: "pass" | "fail" | "invalid"; reason: string } {
  if (r.count === 0 || r.seqs.length === 0) return { state: "invalid", reason: `no event reached the page (Rust sent ${r.count})` };
  if (r.count < r.expected) return { state: "invalid", reason: `Rust ended the burst early: ${r.count} of ${r.expected} emits` };
  const problems = seqProblems(r.seqs, r.count);
  if (problems.length) return { state: "fail", reason: `delivery not exact: ${problems.join("; ")}` };
  if (r.medianUs >= MAX_EMIT_US) return { state: "fail", reason: `median emit ${r.medianUs} us is not under ${MAX_EMIT_US} us` };
  return { state: "pass", reason: "" };
}

async function run(ctx: ProbeContext): Promise<ProbeOutcome> {
  const arrivals: { seq: number; sentMs: number; at: number }[] = [];
  const unlisten = await listen<BurstEvent>(EVENT, (e) => {
    arrivals.push({ seq: e.payload.seq, sentMs: e.payload.sent_ns / 1e6, at: performance.now() });
  });
  try {
    ctx.log(`${HZ} Hz, ${BYTES} bytes, ${SECS} s`);
    // The burst itself cannot be cancelled; a stop only ends the wait for it.
    let stats: Awaited<ReturnType<typeof probeEmitBurst>> | null;
    try {
      stats = await orAbort(probeEmitBurst(HZ, BYTES, SECS), ctx.signal);
    } catch (e) {
      // Rust runs one burst at a time and refuses a second call, so events seen now belong to the old burst.
      return {
        state: "invalid",
        lines: [
          `the burst was refused: ${e instanceof Error ? e.message : String(e)}`,
          `a run within ${SECS} s of the previous one is refused while its burst lasts and reads invalid; its events are not counted`,
        ],
      };
    }
    if (!stats || ctx.signal.aborted) return { state: "invalid", lines: ["stopped"] };
    await waitMs(TAIL_MS, ctx.signal);
    if (ctx.signal.aborted) return { state: "invalid", lines: ["stopped"] };
    const jitter: number[] = [];
    for (let i = 1; i < arrivals.length; i++) {
      const arrival = arrivals[i].at - arrivals[i - 1].at;
      const sent = arrivals[i].sentMs - arrivals[i - 1].sentMs;
      jitter.push(arrival - sent);
    }
    const abs = jitter.map(Math.abs);
    const ordered = arrivals.every((a, i) => i === 0 || a.seq > arrivals[i - 1].seq);
    const lines = [
      `Rust emit time median ${fixed(stats.median_us, 1)} us, p99 ${fixed(stats.p99_us, 1)} us, max ${fixed(stats.max_us, 1)} us over ${stats.count} emits (a full burst is ${HZ * SECS})`,
      `page received ${arrivals.length} of ${stats.count} emits${ordered ? "" : ", not in send order"}`,
      `arrival interval minus send interval (signed): median ${fixed(median(jitter), 2)} ms, min ${fixed(Math.min(0, ...jitter), 2)} ms, max ${fixed(Math.max(0, ...jitter), 2)} ms; absolute: median ${fixed(median(abs), 2)} ms, p99 ${fixed(percentile(abs, 99), 2)} ms, max ${fixed(maxOf(abs), 2)} ms; clock step observed ${fixed(clockStep(arrivals.map((a) => a.at)), 3)} ms`,
    ];
    const verdict = judgeBurst({
      medianUs: stats.median_us,
      count: stats.count,
      seqs: arrivals.map((a) => a.seq),
      expected: HZ * SECS,
    });
    return { state: verdict.state, lines: verdict.reason ? [verdict.reason, ...lines] : lines };
  } finally {
    unlisten();
  }
}

export const probe: ProbeModule = {
  id: "P14a",
  run,
  timeoutMs: 30_000,
};
