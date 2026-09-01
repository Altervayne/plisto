// -- Test Imports --
import { describe, expect, it } from "vitest";

// -- Unit Imports --
import { applyPadding, detectTrim, paddingFrames, sourceStem, trimsAnything } from "./crop";

// -- Type Imports --
import type { SilenceSpan } from "../types";

const TOTAL = 100_000;

function span(start: number, end: number): SilenceSpan {
  return { start_frame: start, end_frame: end };
}

describe("detectTrim", () => {
  it("opens at the full range when there is no silence", () => {
    expect(detectTrim([], TOTAL, 100)).toEqual({ inFrame: 0, outFrame: TOTAL });
  });

  it("takes the head in-point from a leading span that touches the start", () => {
    const base = detectTrim([span(0, 4_000)], TOTAL, 100);
    expect(base).toEqual({ inFrame: 4_000, outFrame: TOTAL });
  });

  it("takes the tail out-point from a trailing span that touches the end", () => {
    const base = detectTrim([span(96_000, TOTAL)], TOTAL, 100);
    expect(base).toEqual({ inFrame: 0, outFrame: 96_000 });
  });

  it("trims both ends when lead-in and lead-out silence are present", () => {
    const base = detectTrim([span(0, 3_000), span(50_000, 51_000), span(97_000, TOTAL)], TOTAL, 100);
    expect(base).toEqual({ inFrame: 3_000, outFrame: 97_000 });
  });

  it("ignores an interior span that touches neither edge", () => {
    const base = detectTrim([span(40_000, 45_000)], TOTAL, 100);
    expect(base).toEqual({ inFrame: 0, outFrame: TOTAL });
  });

  it("accepts an edge within the epsilon slack", () => {
    const base = detectTrim([span(60, 3_000), span(97_000, TOTAL - 60)], TOTAL, 100);
    expect(base).toEqual({ inFrame: 3_000, outFrame: 97_000 });
  });

  it("rejects an edge past the epsilon slack", () => {
    const base = detectTrim([span(500, 3_000)], TOTAL, 100);
    expect(base).toEqual({ inFrame: 0, outFrame: TOTAL });
  });

  it("falls back to the full file when the trim would collapse", () => {
    // One span covering the whole file touches both edges; head at its end would pass its tail start.
    const base = detectTrim([span(0, TOTAL)], TOTAL, 100);
    expect(base).toEqual({ inFrame: 0, outFrame: TOTAL });
  });
});

describe("paddingFrames", () => {
  it("converts milliseconds to whole frames at the sample rate", () => {
    expect(paddingFrames(75, 48_000)).toBe(3_600);
  });

  it("is zero for a non-positive padding", () => {
    expect(paddingFrames(0, 48_000)).toBe(0);
    expect(paddingFrames(-10, 48_000)).toBe(0);
  });
});

describe("applyPadding", () => {
  it("widens the kept region outward on both ends", () => {
    const range = applyPadding({ inFrame: 5_000, outFrame: 90_000 }, 1_000, TOTAL);
    expect(range).toEqual({ in: 4_000, out: 91_000 });
  });

  it("clamps against the file bounds", () => {
    const range = applyPadding({ inFrame: 500, outFrame: 99_800 }, 1_000, TOTAL);
    expect(range).toEqual({ in: 0, out: TOTAL });
  });

  it("is identity at zero padding", () => {
    const range = applyPadding({ inFrame: 5_000, outFrame: 90_000 }, 0, TOTAL);
    expect(range).toEqual({ in: 5_000, out: 90_000 });
  });
});

describe("trimsAnything", () => {
  it("is false for the untouched full range", () => {
    expect(trimsAnything({ in: 0, out: TOTAL }, TOTAL)).toBe(false);
  });

  it("is true when the head is trimmed", () => {
    expect(trimsAnything({ in: 1, out: TOTAL }, TOTAL)).toBe(true);
  });

  it("is true when the tail is trimmed", () => {
    expect(trimsAnything({ in: 0, out: TOTAL - 1 }, TOTAL)).toBe(true);
  });
});

describe("sourceStem", () => {
  it("drops the extension from a Windows path", () => {
    expect(sourceStem("C:\\music\\my long mix.flac")).toBe("my long mix");
  });

  it("drops the extension from a posix path", () => {
    expect(sourceStem("/home/user/set 01.mp3")).toBe("set 01");
  });

  it("keeps a name that has no extension", () => {
    expect(sourceStem("/tmp/rawaudio")).toBe("rawaudio");
  });

  it("keeps a leading-dot name intact", () => {
    expect(sourceStem("/tmp/.hidden")).toBe(".hidden");
  });
});
