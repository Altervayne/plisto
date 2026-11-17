/*
 * The pure parts of the transport probe: a sender that follows the visualizer transport rules (numbered
 * ticks, a credit window, coalescing while out of credit) and the batch timing that measures costs below
 * the clock step. No DOM, so the rules are tested without a frame.
 */

// -- Local Imports --
import { clockStep, perItemMs } from "../stats";

/** Unacknowledged ticks the sender allows. */
export const CREDITS = 2;

/** What the page knows each display frame. */
export interface TickSample {
  dt: number;
  beat: number;
  flux: number;
  kick: number;
  level: number;
  bands: Float32Array;
  raw: Float32Array;
}

export interface Tick extends TickSample {
  type: "tick";
  seq: number;
  /** Beats folded into this tick: `beat` keeps only the max, so this counts what the max hides. */
  nBeats: number;
  /** Wall-clock instant of the post on the sender's clock; stamped by the post callback. */
  sentEpoch: number;
}

export interface SenderStats {
  samples: number;
  ticks: number;
  maxOutstanding: number;
  outstanding: number;
  beatsIn: number;
  beatsSent: number;
  beatsPending: number;
  dtIn: number;
  dtSent: number;
  dtPending: number;
}

/**
 * Sends at most `credits` unacknowledged ticks. While out of credit it folds each sample into one pending
 * tick: `dt` sums, `beat`, `flux` and `kick` keep the max, everything else takes the latest value. No queue
 * exists, so a stalled consumer cannot make it grow.
 */
export class TransportSender {
  private readonly post: (tick: Tick) => void;
  private readonly credits: number;
  private seq = 0;
  private acked = 0;
  private pending: Tick | null = null;
  private samples = 0;
  private ticks = 0;
  private maxOutstanding = 0;
  private beatsIn = 0;
  private beatsSent = 0;
  private dtIn = 0;
  private dtSent = 0;

  constructor(post: (tick: Tick) => void, credits = CREDITS) {
    this.post = post;
    this.credits = credits;
  }

  get outstanding(): number {
    return this.seq - this.acked;
  }

  /** Folds one sample in and sends the pending tick when a credit is free. Returns the tick sent, if any. */
  push(sample: TickSample): Tick | null {
    const beat = sample.beat > 0 ? 1 : 0;
    this.samples++;
    this.dtIn += sample.dt;
    this.beatsIn += beat;
    const p = this.pending;
    if (p) {
      p.dt += sample.dt;
      p.beat = Math.max(p.beat, sample.beat);
      p.flux = Math.max(p.flux, sample.flux);
      p.kick = Math.max(p.kick, sample.kick);
      p.nBeats += beat;
      p.level = sample.level;
      p.bands = sample.bands;
      p.raw = sample.raw;
    } else {
      this.pending = { ...sample, type: "tick", seq: 0, nBeats: beat, sentEpoch: 0 };
    }
    return this.flush();
  }

  /** The consumer took tick `seq`: it and every earlier tick are settled. */
  ack(seq: number): void {
    if (seq > this.acked) this.acked = Math.min(seq, this.seq);
  }

  private flush(): Tick | null {
    const tick = this.pending;
    if (!tick || this.outstanding >= this.credits) return null;
    this.pending = null;
    tick.seq = ++this.seq;
    this.ticks++;
    this.beatsSent += tick.nBeats;
    this.dtSent += tick.dt;
    this.maxOutstanding = Math.max(this.maxOutstanding, this.outstanding);
    this.post(tick);
    return tick;
  }

  stats(): SenderStats {
    return {
      samples: this.samples,
      ticks: this.ticks,
      maxOutstanding: this.maxOutstanding,
      outstanding: this.outstanding,
      beatsIn: this.beatsIn,
      beatsSent: this.beatsSent,
      beatsPending: this.pending?.nBeats ?? 0,
      dtIn: this.dtIn,
      dtSent: this.dtSent,
      dtPending: this.pending?.dt ?? 0,
    };
  }
}

/** A timer that also ends when `signal` aborts, so a stopped run does not sit out its waits. */
export function waitMs(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve();
    const end = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", end);
      resolve();
    };
    const timer = setTimeout(end, ms);
    signal.addEventListener("abort", end, { once: true });
  });
}

/** The promise's value, or null once `signal` aborts first. */
export function orAbort<T>(promise: Promise<T>, signal: AbortSignal): Promise<T | null> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) return resolve(null);
    const onAbort = () => resolve(null);
    signal.addEventListener("abort", onAbort, { once: true });
    promise.then(
      (value) => {
        signal.removeEventListener("abort", onAbort);
        resolve(value);
      },
      (error) => {
        signal.removeEventListener("abort", onAbort);
        reject(error);
      },
    );
  });
}

/**
 * Waits for the first message of `type` on `port`, replacing the port's handler. Resolves null after
 * `ms`, when `signal` aborts, or when `send` throws. `send` runs once the handler is installed.
 */
export function awaitMessage<T extends { type?: string }>(
  port: MessagePort,
  type: string,
  ms: number,
  signal: AbortSignal,
  send?: () => void,
): Promise<T | null> {
  return new Promise((resolve) => {
    if (signal.aborted) return resolve(null);
    const end = (value: T | null) => {
      clearTimeout(timer);
      signal.removeEventListener("abort", onAbort);
      port.onmessage = null;
      resolve(value);
    };
    const onAbort = () => end(null);
    const timer = setTimeout(() => end(null), ms);
    signal.addEventListener("abort", onAbort, { once: true });
    port.onmessage = (e: MessageEvent) => {
      const d = e.data as T | null;
      if (d?.type === type) end(d);
    };
    try {
      send?.();
    } catch {
      end(null);
    }
  });
}

export interface BatchTiming {
  /** Wall time of each batch. */
  batchMs: number[];
  /** Each batch's time divided by its size. */
  perItem: number[];
}

/** Runs `step` `batchSize` times per batch for `batches` batches, timing each batch as a whole. */
export function timeBatches(
  batches: number,
  batchSize: number,
  step: (index: number) => void,
  now: () => number,
): BatchTiming {
  const batchMs: number[] = [];
  let index = 0;
  for (let b = 0; b < batches; b++) {
    const start = now();
    for (let i = 0; i < batchSize; i++) step(index++);
    batchMs.push(now() - start);
  }
  return { batchMs, perItem: perItemMs(batchMs, batchSize) };
}

/** The clock's smallest observed step: spins until the reading changes, `samples` times over. */
export function observeClockStep(now: () => number, samples = 20, maxSpin = 1_000_000): number {
  const readings: number[] = [];
  for (let i = 0; i < samples; i++) {
    const first = now();
    readings.push(first);
    for (let spin = 0; spin < maxSpin; spin++) {
      const next = now();
      if (next !== first) {
        readings.push(next);
        break;
      }
    }
  }
  return clockStep(readings);
}
