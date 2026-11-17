// -- Test Imports --
import { describe, expect, it } from "vitest";

// -- Unit Imports --
import { stableCapture, type Capture, type StageRects, type StableIo } from "./stageCapture";

const rect = { x: 10, y: 10, w: 100, h: 50 };
const rects = (scrolled = false, x = 10): StageRects => ({
  reference: { ...rect, x },
  subject: { ...rect, x: 200 },
  offGrid: false,
  scrolled,
});
const cap = {} as Capture;

/** An io whose measurements come from a list and whose calls are recorded. */
function fake(measures: StageRects[]): { io: StableIo; calls: string[] } {
  const calls: string[] = [];
  let i = 0;
  const io: StableIo = {
    measure: () => {
      calls.push("measure");
      return measures[Math.min(i++, measures.length - 1)];
    },
    capture: async () => {
      calls.push("capture");
      return cap;
    },
    settle: async () => {
      calls.push("settle");
    },
  };
  return { io, calls };
}

const live = new AbortController().signal;

describe("stableCapture", () => {
  it("captures once when the stages are at rest", async () => {
    const { io, calls } = fake([rects(), rects()]);
    expect((await stableCapture(io, live)).ok).toBe(true);
    expect(calls).toEqual(["measure", "capture", "measure"]);
  });

  it("settles and measures again before capturing after a scroll", async () => {
    const { io, calls } = fake([rects(true), rects(), rects()]);
    expect((await stableCapture(io, live)).ok).toBe(true);
    expect(calls).toEqual(["measure", "settle", "measure", "capture", "measure"]);
  });

  it("retakes once when the stages moved, then reports the case unreadable", async () => {
    const { io, calls } = fake([rects(), rects(false, 40), rects(false, 40), rects(false, 70)]);
    const got = await stableCapture(io, live);
    expect(got).toEqual({ ok: false, reason: "the stages moved during the capture" });
    expect(calls.filter((c) => c === "capture")).toHaveLength(2);
  });

  it("accepts the retake when the stages are still the second time", async () => {
    const { io } = fake([rects(), rects(false, 40), rects(false, 40), rects(false, 40)]);
    expect((await stableCapture(io, live)).ok).toBe(true);
  });
});
