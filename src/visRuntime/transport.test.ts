import { describe, expect, it } from "vitest";

import { createTickSender } from "./protocol";
import { createFrameTransport, DT_MAX } from "./transport";
import { restSignal } from "../state/player/visualSignal";

import type { Tick } from "./protocol";

const FEED_MS = 1000 / 30;
const LATENCY_MS = 2;

interface SimOptions {
  // The animation frame interval in ms; Infinity for a frame that never gets one.
  rafMs: number;
  // What one step costs the frame, in ms.
  stepMs?: number;
  // How long the host feeds, in ms.
  feedMs?: number;
  // The feed's tick indices that carry a beat.
  beats?: Set<number>;
  // A stretch the frame runs nothing at all: [from, to] in ms.
  freeze?: [number, number];
}

interface Step {
  at: number;
  tick: Tick;
  dt: number;
  // How many delivered ticks the frame folded into this step.
  delivered: number;
}

/**
 * Runs the host's sender against the frame's transport on one simulated clock. The frame is one thread:
 * its events wait while a step runs or while it is frozen; messages cross in LATENCY_MS each way.
 */
function simulate(opts: SimOptions) {
  const queue: { at: number; order: number; frame: boolean; run: () => void }[] = [];
  let order = 0;
  let now = 0;
  let frameBusyUntil = 0;
  const schedule = (at: number, frame: boolean, run: () => void) => {
    queue.push({ at, order: order++, frame, run });
  };

  const steps: Step[] = [];
  let sentDt = 0;
  let sentBeats = 0;
  let maxOutstanding = 0;
  // Ticks that reached the frame and that it has not acked yet, and the most there ever were.
  let unacked: number[] = [];
  let maxUnacked = 0;
  let sinceStep = 0;
  const cancelled = new Set<number>();
  let frameIds = 0;

  const transport = createFrameTransport({
    now: () => now,
    requestFrame(cb) {
      const id = ++frameIds;
      if (Number.isFinite(opts.rafMs)) {
        // The next vsync strictly after now; the epsilon keeps a float product from landing on now again.
        const at = (Math.floor(now / opts.rafMs + 1e-9) + 1) * opts.rafMs;
        schedule(at, true, () => {
          if (!cancelled.has(id)) cb();
        });
      }
      return id;
    },
    cancelFrame: (id) => cancelled.add(id),
    postAck(seq) {
      unacked = unacked.filter((s) => s > seq);
      schedule(now + LATENCY_MS, false, () => sender.ack(seq));
    },
    step(tick, dt) {
      steps.push({ at: now, tick, dt, delivered: sinceStep });
      sinceStep = 0;
      now += opts.stepMs ?? 0;
    },
  });

  const sender = createTickSender((tick) => {
    schedule(now + LATENCY_MS, true, () => {
      unacked.push(tick.seq);
      maxUnacked = Math.max(maxUnacked, unacked.length);
      sinceStep += 1;
      transport.onTick(tick);
    });
  });

  const feedMs = opts.feedMs ?? 20_000;
  const count = Math.round(feedMs / FEED_MS);
  for (let i = 0; i < count; i++) {
    schedule(i * FEED_MS, false, () => {
      const beat = opts.beats?.has(i) ?? false;
      sentDt += 1 / 30;
      if (beat) sentBeats += 1;
      sender.offer({
        seq: i + 1,
        t: i / 30,
        dt: 1 / 30,
        sig: { ...restSignal(), beat: beat ? 1 : 0 },
        nBeats: beat ? 1 : 0,
        beatAt: null,
        rawBands: [],
        fine: null,
        playing: true,
        trackSeq: 1,
        progress: null,
        pointer: null,
        wave: null,
      });
      maxOutstanding = Math.max(maxOutstanding, sender.outstanding());
    });
  }

  while (queue.length > 0) {
    queue.sort((a, b) => a.at - b.at || a.order - b.order);
    const next = queue.shift()!;
    const at = next.at;
    if (next.frame) {
      const blockedUntil = Math.max(frameBusyUntil, opts.freeze && at >= opts.freeze[0] && at < opts.freeze[1] ? opts.freeze[1] : 0);
      if (at < blockedUntil) {
        schedule(blockedUntil, true, next.run);
        continue;
      }
    }
    now = at;
    next.run();
    if (next.frame) frameBusyUntil = now;
  }

  return { steps, sentDt, sentBeats, maxOutstanding, maxUnacked };
}

// 41 beats spread over the first 20 seconds of a 30 fps feed.
const BEATS = new Set(Array.from({ length: 41 }, (_, k) => 5 + 14 * k));

const sumDt = (steps: Step[]) => steps.reduce((s, x) => s + x.tick.dt, 0);
const sumBeats = (steps: Step[]) => steps.reduce((s, x) => s + x.tick.nBeats, 0);

describe("frame transport over 20 s of a 30 fps feed", () => {
  const cases: [string, SimOptions][] = [
    ["a visible frame", { rafMs: 1000 / 60 }],
    ["a frame with no animation frames", { rafMs: Infinity }],
    ["a frame throttled to one animation frame a second", { rafMs: 1000 }],
    ["a frame whose steps take 80 ms", { rafMs: 1000 / 60, stepMs: 80 }],
  ];

  for (const [name, opts] of cases) {
    it(`loses no time and no beat, with at most 2 ticks outstanding, for ${name}`, () => {
      const run = simulate({ ...opts, beats: BEATS });
      expect(run.sentBeats).toBe(41);
      expect(sumBeats(run.steps)).toBe(41);
      expect(sumDt(run.steps)).toBeCloseTo(run.sentDt, 9);
      expect(run.maxOutstanding).toBeLessThanOrEqual(2);
      expect(run.maxUnacked).toBeLessThanOrEqual(2);
      for (const step of run.steps) expect(step.dt).toBeLessThanOrEqual(DT_MAX);
    });
  }

  it("folds on the frame side when its steps cannot keep up, holding at most 2 unacked ticks", () => {
    for (const opts of [{ rafMs: 1000 / 60, stepMs: 80 }, { rafMs: 1000 }]) {
      const run = simulate({ ...opts, beats: BEATS });
      expect(run.steps.some((s) => s.delivered > 1)).toBe(true);
      expect(run.maxUnacked).toBeLessThanOrEqual(2);
      expect(sumBeats(run.steps)).toBe(41);
    }
  });

  it("draws every tick in step with the display when the frame keeps up", () => {
    const run = simulate({ rafMs: 1000 / 60, beats: BEATS });
    expect(run.steps).toHaveLength(600);
  });

  it("still draws on ticks when animation frames never come", () => {
    const run = simulate({ rafMs: Infinity });
    expect(run.steps.length).toBeGreaterThan(550);
  });
});

describe("frame transport after a long gap", () => {
  it("resumes with one clamped step that carries the whole gap and its beats", () => {
    const beats = new Set([300, 600, 900]);
    const run = simulate({ rafMs: 1000 / 60, feedMs: 40_000, beats, freeze: [5_000, 35_000] });
    const long = run.steps.filter((s) => s.tick.dt > 1);
    expect(long).toHaveLength(1);
    expect(long[0].dt).toBe(DT_MAX);
    expect(long[0].tick.dt).toBeGreaterThan(29);
    expect(long[0].tick.nBeats).toBe(3);
    expect(sumDt(run.steps)).toBeCloseTo(run.sentDt, 9);
    expect(sumBeats(run.steps)).toBe(3);
    for (const step of run.steps) expect(step.dt).toBeLessThanOrEqual(DT_MAX);
  });
});

describe("frame transport idling", () => {
  it("stops asking for animation frames 250 ms after the last tick", () => {
    let requested = 0;
    let pendingFrame: (() => void) | null = null;
    let now = 0;
    const transport = createFrameTransport({
      now: () => now,
      requestFrame(cb) {
        requested += 1;
        pendingFrame = cb;
        return requested;
      },
      cancelFrame: () => {},
      postAck: () => {},
      step: () => {},
    });
    transport.onTick({ seq: 1, t: 0, dt: 1 / 30, sig: restSignal(), nBeats: 0, beatAt: null, rawBands: [], fine: null, playing: true, trackSeq: 1, progress: null, pointer: null, wave: null });
    for (let i = 0; i < 30; i++) {
      now += 1000 / 60;
      const cb = pendingFrame as (() => void) | null;
      pendingFrame = null;
      cb?.();
    }
    expect(pendingFrame).toBeNull();
    expect(requested).toBeLessThan(18);
  });
});
