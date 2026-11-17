// -- Test Imports --
import { describe, expect, it } from "vitest";

// -- Unit Imports --
import { judgeBurst, seqProblems } from "./p14Emit";

const from0 = (n: number) => Array.from({ length: n }, (_, i) => i);
const full = { medianUs: 20, count: 300, seqs: from0(300), expected: 300 };

describe("judgeBurst", () => {
  it("passes a full delivery with a median under 100 us", () => {
    expect(judgeBurst({ ...full, medianUs: 99.9 }).state).toBe("pass");
  });

  it("accepts a burst numbered from 1", () => {
    expect(judgeBurst({ ...full, seqs: from0(300).map((s) => s + 1) }).state).toBe("pass");
  });

  it("fails a median of 100 us or more", () => {
    expect(judgeBurst({ ...full, medianUs: 100 }).state).toBe("fail");
  });

  it("fails when the page received fewer events than Rust sent, however fast the emits", () => {
    const v = judgeBurst({ ...full, seqs: [0] });
    expect(v.state).toBe("fail");
    expect(v.reason).toContain("received 1 events for 300 sent");
  });

  it("fails extra events and names duplicates and strays", () => {
    const v = judgeBurst({ ...full, seqs: [...from0(300), 7, 301, 302] });
    expect(v.state).toBe("fail");
    expect(v.reason).toContain("duplicates: 7");
    expect(v.reason).toContain("stray sequence numbers: 301, 302");
  });

  it("is invalid when Rust ended the burst early", () => {
    const v = judgeBurst({ ...full, count: 120, seqs: from0(120) });
    expect(v.state).toBe("invalid");
    expect(v.reason).toContain("120 of 300");
  });

  it("is invalid when nothing arrived", () => {
    expect(judgeBurst({ ...full, seqs: [] }).state).toBe("invalid");
  });
});

describe("seqProblems", () => {
  it("is empty for exactly one of each number", () => {
    expect(seqProblems(from0(5), 5)).toEqual([]);
  });

  it("names a missing number", () => {
    expect(seqProblems([0, 1, 3, 4, 2].filter((s) => s !== 2), 5).join(" ")).toContain("missing: 2");
  });
});
