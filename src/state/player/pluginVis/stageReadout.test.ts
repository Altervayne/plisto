import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { createReadoutSampler, READOUT_SAMPLE_MS, startReadout, type ReadoutDeps } from "./stageReadout";
import type { StageHandle } from "./frameCache";
import type { TransportStats } from "./transport";

const KIND = "com.example.rings/aurora";

function setup(surface: "player" | "ambient" = "player") {
  const clock = { now: 0 };
  const state = {
    shown: true,
    phase: "ready",
    metered: true as boolean | null,
    stats: { outstanding: 1, acked: 0, lastAckMs: 2.46 } as Partial<TransportStats> | null,
  };
  const make = () =>
    ({
      kind: KIND,
      surface,
      shown: () => state.shown,
      phase: () => state.phase,
      metered: () => state.metered,
      stats: () => state.stats,
    }) as unknown as StageHandle;
  const list = { handles: [make()] };
  const deps: ReadoutDeps = { now: () => clock.now, handles: () => list.handles };
  return { clock, state, list, deps, make };
}

beforeEach(() => vi.useFakeTimers());
afterEach(() => vi.useRealTimers());

describe("the sampler", () => {
  it("reads acks per second over a sliding second, and the frame cost to one decimal", () => {
    const s = setup();
    const sample = createReadoutSampler(KIND, "player", s.deps);
    expect(sample().fps).toBeNull();
    for (let i = 1; i <= 9; i++) {
      s.clock.now += 250;
      s.state.stats!.acked = i * 15;
      sample();
    }
    const r = sample();
    expect(r.fps).toBe(60);
    expect(r.frameMs).toBe("2.5");
    expect(r.inFlight).toBe(1);
    expect(r.meter).toBe("on");
  });

  it("follows a slowdown within a second", () => {
    const s = setup();
    const sample = createReadoutSampler(KIND, "player", s.deps);
    sample();
    for (let i = 0; i < 4; i++) {
      s.clock.now += 250;
      s.state.stats!.acked! += 15;
      sample();
    }
    for (let i = 0; i < 4; i++) {
      s.clock.now += 250;
      s.state.stats!.acked! += 2;
      sample();
    }
    expect(sample().fps).toBe(8);
  });

  it("reports the meter as not watched or unknown", () => {
    const s = setup();
    const sample = createReadoutSampler(KIND, "player", s.deps);
    s.state.metered = false;
    expect(sample().meter).toBe("unwatched");
    s.state.metered = null;
    expect(sample().meter).toBe("unknown");
  });

  it("has no values before a stats read or while the kind is not shown", () => {
    const s = setup();
    const sample = createReadoutSampler(KIND, "player", s.deps);
    s.state.stats = null;
    expect(sample().inFlight).toBeNull();
    s.state.stats = { outstanding: 2, acked: 0, lastAckMs: null };
    expect(sample().frameMs).toBeNull();
    s.state.shown = false;
    expect(sample().inFlight).toBeNull();
  });

  it("ignores the other surface and re-bases on a new handle", () => {
    const other = setup("ambient");
    expect(createReadoutSampler(KIND, "player", other.deps)().inFlight).toBeNull();
    const s = setup();
    const sample = createReadoutSampler(KIND, "player", s.deps);
    sample();
    s.clock.now += 500;
    s.state.stats!.acked = 30;
    expect(sample().fps).toBe(60);
    s.list.handles = [s.make()];
    s.clock.now += 250;
    expect(sample().fps).toBeNull();
  });
});

describe("the timer", () => {
  it("reports on a clock, and stops when released", () => {
    const s = setup();
    const seen = vi.fn();
    const stop = startReadout(KIND, "player", seen, s.deps);
    expect(seen).toHaveBeenCalledTimes(1);
    vi.advanceTimersByTime(READOUT_SAMPLE_MS * 4);
    expect(seen).toHaveBeenCalledTimes(5);
    stop();
    vi.advanceTimersByTime(READOUT_SAMPLE_MS * 8);
    expect(seen).toHaveBeenCalledTimes(5);
    expect(vi.getTimerCount()).toBe(0);
  });
});
