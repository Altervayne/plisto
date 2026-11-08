// -- Test Imports --
import { describe, expect, it } from "vitest";

// -- Unit Imports --
import { DIP_SECS, createDip, dipOpacity, stepDip, type DipInput, type DipState } from "./visualizerDip";
import { VISUALIZER_KINDS, type VisualizerKind } from "./visualizerKind";

const FRAME = 1 / 60;

// The steepest slope of smoothstep is 1.5, so one frame moves the opacity at most this far.
const FRAME_BOUND = (1.5 * FRAME) / (DIP_SECS.manual / 2);

function input(target: VisualizerKind, patch: Partial<DipInput> = {}): DipInput {
  return { target, ready: true, reason: "manual", reduced: false, ...patch };
}

interface Trace {
  states: DipState[];
  opacities: number[];
  // The frame counts at which the shown kind changed.
  swaps: number[];
}

/** Steps `frames` frames from `start`; frame k (from 1) ends at k x FRAME and reads `inputAt(k)`. */
function run(start: DipState, inputAt: (k: number) => DipInput, frames: number): Trace {
  const trace: Trace = { states: [start], opacities: [dipOpacity(start)], swaps: [] };
  let state = start;
  for (let k = 1; k <= frames; k++) {
    const step = stepDip(state, inputAt(k), FRAME);
    state = step.state;
    trace.states.push(state);
    trace.opacities.push(dipOpacity(state));
    if (step.swapped) trace.swaps.push(k);
  }
  return trace;
}

function last<T>(items: T[]): T {
  return items[items.length - 1];
}

function maxStep(opacities: number[]): number {
  let max = 0;
  for (let i = 1; i < opacities.length; i++) max = Math.max(max, Math.abs(opacities[i] - opacities[i - 1]));
  return max;
}

describe("stepDip timing", () => {
  it("swaps a manual dip at 0.3 s and is back at full opacity at 0.6 s", () => {
    const trace = run(createDip("ridge"), () => input("glass"), 40);
    expect(trace.swaps).toEqual([18]);
    expect(trace.opacities[18]).toBeCloseTo(0, 9);
    expect(trace.opacities[35]).toBeLessThan(1);
    expect(trace.opacities[36]).toBe(1);
    expect(trace.states[36].shown).toBe("glass");
  });

  it("swaps a boundary dip at 0.75 s and ends at 1.5 s", () => {
    const trace = run(createDip("ridge"), () => input("glass", { reason: "boundary" }), 100);
    expect(trace.swaps).toEqual([45]);
    expect(trace.opacities[89]).toBeLessThan(1);
    expect(trace.opacities[90]).toBe(1);
  });

  it("carries time left over at the swap into the rise", () => {
    const step = stepDip(createDip("ridge"), input("glass"), 0.4);
    expect(step.swapped).toBe(true);
    expect(step.state.shown).toBe("glass");
    expect(step.state.p).toBeCloseTo(0.1 / 0.3);
  });
});

describe("stepDip retargets", () => {
  it("continues a retarget mid-fall from the current opacity", () => {
    const inputAt = (k: number) => (k < 9 ? input("warp") : input("glass", { reason: "boundary" }));
    const trace = run(createDip("ridge"), inputAt, 120);
    expect(trace.states[8].p).toBeCloseTo(1 - 8 / 18);
    expect(trace.states[9].p).toBeCloseTo(1 - 8 / 18 - FRAME / (DIP_SECS.boundary / 2));
    expect(maxStep(trace.opacities)).toBeLessThanOrEqual(FRAME_BOUND + 1e-9);
    expect(trace.swaps).toHaveLength(1);
    expect(last(trace.states)).toMatchObject({ shown: "glass", p: 1 });
  });

  it("rises without a swap when retargeted back to the shown kind mid-fall", () => {
    const trace = run(createDip("ridge"), (k) => input(k <= 9 ? "warp" : "ridge"), 30);
    expect(trace.states[9].p).toBeCloseTo(0.5);
    expect(trace.states[10].p).toBeGreaterThan(trace.states[9].p);
    expect(trace.swaps).toEqual([]);
    expect(trace.states[18]).toMatchObject({ shown: "ridge", p: 1 });
  });

  it("ends three picks 150 ms apart on the last pick with one swap", () => {
    const picks: VisualizerKind[] = ["warp", "glass", "nebula"];
    const trace = run(createDip("ridge"), (k) => input(picks[Math.min(2, Math.floor(k / 9))]), 60);
    expect(trace.swaps).toHaveLength(1);
    expect(last(trace.states)).toMatchObject({ shown: "nebula", target: "nebula", p: 1 });
  });
});

describe("stepDip readiness", () => {
  it("holds the shown kind at full opacity until the target is ready, then dips", () => {
    const trace = run(createDip("warp"), (k) => input("glass", { ready: k > 30 }), 80);
    for (let k = 0; k <= 30; k++) {
      expect(trace.states[k].shown).toBe("warp");
      expect(trace.opacities[k]).toBe(1);
    }
    expect(trace.swaps).toEqual([48]);
    expect(last(trace.states)).toMatchObject({ shown: "glass", p: 1 });
  });

  it("turns back up when the target goes not-ready mid-fall", () => {
    const trace = run(createDip("warp"), (k) => input("glass", { ready: k <= 9 }), 30);
    expect(trace.states[9].p).toBeCloseTo(0.5);
    expect(trace.states[10].p).toBeGreaterThan(0.5);
    expect(trace.swaps).toEqual([]);
    expect(trace.states[18]).toMatchObject({ shown: "warp", p: 1 });
  });
});

describe("stepDip reduced motion", () => {
  it("swaps at once with full opacity", () => {
    const step = stepDip(createDip("ridge"), input("glass", { reduced: true }), FRAME);
    expect(step.swapped).toBe(true);
    expect(step.state).toMatchObject({ shown: "glass", target: "glass" });
    expect(dipOpacity(step.state)).toBe(1);
  });

  it("finishes a dip already under way in one step", () => {
    const mid = run(createDip("ridge"), () => input("glass"), 9);
    const step = stepDip(last(mid.states), input("glass", { reduced: true }), FRAME);
    expect(step.swapped).toBe(true);
    expect(dipOpacity(step.state)).toBe(1);
  });
});

describe("stepDip and Off", () => {
  it("swaps away from Off on the first step and rises from zero", () => {
    const trace = run(createDip("off"), () => input("ridge"), 20);
    expect(trace.opacities[0]).toBe(0);
    expect(trace.swaps).toEqual([1]);
    expect(trace.states[1].shown).toBe("ridge");
    expect(trace.opacities[1]).toBeLessThanOrEqual(FRAME_BOUND);
    expect(trace.opacities[18]).toBe(1);
  });

  it("falls before swapping to Off, then settles at zero", () => {
    const trace = run(createDip("ridge"), () => input("off"), 30);
    expect(trace.swaps).toEqual([18]);
    expect(trace.opacities[17]).toBeGreaterThan(0);
    expect(trace.states[18]).toMatchObject({ shown: "off", p: 1 });
    expect(last(trace.opacities)).toBe(0);
  });
});

// A small seeded generator, so a failing sequence replays exactly.
function lcg(seed: number): () => number {
  let s = seed >>> 0;
  return () => {
    s = (Math.imul(s, 1664525) + 1013904223) >>> 0;
    return s / 4294967296;
  };
}

describe("stepDip property", () => {
  it("keeps the opacity continuous over random pick sequences", () => {
    // How far any frame moved the opacity past its bound, so zero or below passes.
    let worstJump = -Infinity;
    let outOfRange = 0;
    for (let seed = 1; seed <= 200; seed++) {
      const rand = lcg(seed);
      const pick = (): VisualizerKind => VISUALIZER_KINDS[Math.floor(rand() * VISUALIZER_KINDS.length)];
      let state = createDip(pick());
      let current = input(pick());
      for (let k = 0; k < 600; k++) {
        if (rand() < 0.05) current = input(pick(), { reason: rand() < 0.5 ? "manual" : "boundary" });
        if (rand() < 0.03) current = { ...current, ready: !current.ready };
        const dt = FRAME * (0.25 + rand() * 1.75);
        const before = dipOpacity(state);
        state = stepDip(state, current, dt).state;
        const jump = Math.abs(dipOpacity(state) - before) - (1.5 * dt) / (DIP_SECS.manual / 2);
        worstJump = Math.max(worstJump, jump);
        if (state.p < 0 || state.p > 1) outOfRange++;
      }
      const settle = { ...current, ready: true };
      for (let k = 0; k < 120; k++) state = stepDip(state, settle, FRAME).state;
      expect(state).toMatchObject({ shown: settle.target, p: 1 });
    }
    expect(worstJump).toBeLessThanOrEqual(1e-9);
    expect(outOfRange).toBe(0);
  });
});
