import { describe, expect, it } from "vitest";
import { HANG_LIMIT_MS } from "./netLimits";
import {
  LOOP_GAP_MS,
  SLOW_CONFIRM_MS,
  SLOW_PAUSE_MS,
  createHangWatch,
  createSlowWatch,
  median,
  type NetInput,
} from "./nets";
import type { StagePhase } from "./stageMount";
import type { TransportStats } from "./transport";

const FRAME = 16;

function stats(over: Partial<TransportStats> = {}): TransportStats {
  return {
    visible: true,
    visibleSince: 0,
    sent: 10,
    acked: 8,
    outstanding: 2,
    lastSentAt: 0,
    lastAckAt: 0,
    lastAckMs: 5,
    withheld: 0,
    ...over,
  };
}

function input(now: number, over: Partial<TransportStats> = {}, phase: StagePhase = "ready"): NetInput {
  const s = stats(over);
  return { now, phase, stats: s, slotVisible: s.visible };
}

/** Steps a hang watch every `every` ms from `from` to `to`; true when it tripped on the way. */
function run(
  watch: ReturnType<typeof createHangWatch>,
  from: number,
  to: number,
  every = FRAME,
  over: Partial<TransportStats> = {},
  phase: StagePhase = "ready",
): boolean {
  let tripped = false;
  for (let now = from; now <= to; now += every) tripped = watch.step(input(now, over, phase)) || tripped;
  return tripped;
}

describe("hang watch", () => {
  it("trips once ticks go unanswered for the limit while the loop runs and the slot shows", () => {
    const watch = createHangWatch();
    expect(run(watch, 0, HANG_LIMIT_MS - 100)).toBe(false);
    expect(run(watch, HANG_LIMIT_MS - 100 + FRAME, HANG_LIMIT_MS + 200)).toBe(true);
  });

  it("starts over on every answer", () => {
    const watch = createHangWatch();
    let acked = 0;
    let tripped = false;
    for (let now = 0; now <= HANG_LIMIT_MS * 3; now += FRAME) {
      if (now % 1000 === 0) acked++;
      tripped = watch.step(input(now, { acked })) || tripped;
    }
    expect(tripped).toBe(false);
  });

  it("reads no hang from a hidden slot, however long it is silent", () => {
    const watch = createHangWatch();
    expect(run(watch, 0, HANG_LIMIT_MS * 5, FRAME, { visible: false, visibleSince: null })).toBe(false);
  });

  it("reads no hang from a throttled loop", () => {
    const watch = createHangWatch();
    expect(run(watch, 0, HANG_LIMIT_MS * 10, LOOP_GAP_MS + 750)).toBe(false);
  });

  it("reads no hang across a minimize and restore, but still catches a hang after it", () => {
    const watch = createHangWatch();
    expect(run(watch, 0, HANG_LIMIT_MS - 300)).toBe(false);
    const back = HANG_LIMIT_MS + 30_000;
    expect(run(watch, back, back + HANG_LIMIT_MS - 300)).toBe(false);
    expect(run(watch, back + HANG_LIMIT_MS - 300 + FRAME, back + HANG_LIMIT_MS + 300)).toBe(true);
  });

  it("starts over when the slot becomes visible again", () => {
    const watch = createHangWatch();
    expect(run(watch, 0, HANG_LIMIT_MS - 300)).toBe(false);
    const from = HANG_LIMIT_MS - 300 + FRAME;
    expect(run(watch, from, HANG_LIMIT_MS + 500, FRAME, { visibleSince: 1500 })).toBe(false);
  });

  it("counts nothing with no tick out, and nothing before the first frame", () => {
    expect(run(createHangWatch(), 0, HANG_LIMIT_MS * 3, FRAME, { outstanding: 0 })).toBe(false);
    expect(run(createHangWatch(), 0, HANG_LIMIT_MS * 3, FRAME, {}, "mounting")).toBe(false);
    expect(run(createHangWatch(), 0, HANG_LIMIT_MS * 3, FRAME, {}, "slow")).toBe(false);
  });
});

/** Steps a slow watch with one answer per frame at the given cost; returns every hold and trip seen. */
function slowRun(
  watch: ReturnType<typeof createSlowWatch>,
  from: number,
  to: number,
  cost: (now: number) => number | null,
  visible: (now: number) => boolean = () => true,
) {
  const out = { holds: [] as number[], slow: false };
  for (let now = from; now <= to; now += FRAME) {
    const acked = Math.floor(now / FRAME);
    const s = stats({ acked, lastAckMs: cost(now), visible: visible(now) });
    const step = watch.step({ now, phase: "ready", stats: s, slotVisible: s.visible });
    if (step.hold) out.holds.push(now);
    out.slow ||= step.slow;
  }
  return out;
}

describe("slow-frame watch", () => {
  it("pauses ticks once the median stays over the limit for the span, then trips if the cost stays", () => {
    const watch = createSlowWatch();
    const seen = slowRun(watch, 0, 5500 + SLOW_PAUSE_MS + SLOW_CONFIRM_MS + 200, () => 80);
    expect(seen.holds.length).toBeGreaterThan(0);
    expect(seen.holds[0]).toBeGreaterThanOrEqual(4700);
    expect(seen.holds[seen.holds.length - 1] - seen.holds[0]).toBeLessThan(SLOW_PAUSE_MS);
    expect(seen.slow).toBe(true);
  });

  it("keeps a frame that recovers after the pause", () => {
    const watch = createSlowWatch();
    let pausedAt: number | null = null;
    const cost = (now: number) => (pausedAt != null && now > pausedAt ? 10 : 80);
    const seen = { slow: false };
    for (let now = 0; now <= 9000; now += FRAME) {
      const s = stats({ acked: Math.floor(now / FRAME), lastAckMs: cost(now) });
      const step = watch.step({ now, phase: "ready", stats: s, slotVisible: true });
      if (step.hold) pausedAt ??= now;
      seen.slow ||= step.slow;
    }
    expect(pausedAt).not.toBeNull();
    expect(seen.slow).toBe(false);
  });

  it("never reads a missing cost as a reading", () => {
    const seen = slowRun(createSlowWatch(), 0, 12_000, () => null);
    expect(seen.holds).toEqual([]);
    expect(seen.slow).toBe(false);
  });

  it("starts the span over when the slot hides", () => {
    const seen = slowRun(createSlowWatch(), 0, 5200, () => 80, (now) => now < 3000 || now > 3100);
    expect(seen.holds).toEqual([]);
  });

  it("keeps a frame under the limit", () => {
    const seen = slowRun(createSlowWatch(), 0, 12_000, (now) => (now % 3 === 0 ? 70 : 30));
    expect(seen.holds).toEqual([]);
  });
});

describe("median", () => {
  it("takes the middle reading, or the mean of the two middle ones", () => {
    expect(median([5, 1, 3])).toBe(3);
    expect(median([4, 1, 3, 2])).toBe(2.5);
  });
});
