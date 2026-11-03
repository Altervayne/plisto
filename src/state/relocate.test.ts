// -- Test Imports --
import { describe, expect, it } from "vitest";

// -- Unit Imports --
import { bestCandidate, locateEligible, needsRelinkCheck } from "./relocate";

// -- Type Imports --
import type { RelinkCandidate, Root } from "../types";

const root = (id: number, track_count: number, missing_count = 0): Root => ({
  id,
  path: `/music${id}`,
  track_count,
  missing_count,
});

const cand = (root_id: number, sampled: number, matched: number): RelinkCandidate => ({
  root_id,
  path: `/music${root_id}`,
  total: 100,
  sampled,
  matched,
  partial: matched < sampled,
});

describe("locateEligible", () => {
  it("accepts an offline root", () => {
    expect(locateEligible(root(1, 10), [1])).toBe(true);
  });

  it("accepts an online root whose every track is gone", () => {
    expect(locateEligible(root(1, 10, 10), [])).toBe(true);
  });

  it("rejects an online root with some tracks present", () => {
    expect(locateEligible(root(1, 10, 9), [])).toBe(false);
  });

  it("rejects an empty online root", () => {
    expect(locateEligible(root(1, 0, 0), [])).toBe(false);
  });

  it("ignores offline flags for other roots", () => {
    expect(locateEligible(root(1, 10), [2])).toBe(false);
  });
});

describe("needsRelinkCheck", () => {
  it("is false when every root is online and stocked", () => {
    expect(needsRelinkCheck([root(1, 10), root(2, 4, 1)], [])).toBe(false);
  });

  it("is true when any root is offline", () => {
    expect(needsRelinkCheck([root(1, 10), root(2, 4)], [2])).toBe(true);
  });

  it("is true when any root is all-missing", () => {
    expect(needsRelinkCheck([root(1, 10), root(2, 4, 4)], [])).toBe(true);
  });

  it("is false with no roots", () => {
    expect(needsRelinkCheck([], [])).toBe(false);
  });
});

describe("bestCandidate", () => {
  it("is null for no candidates", () => {
    expect(bestCandidate([])).toBeNull();
  });

  it("returns a lone candidate", () => {
    const only = cand(1, 48, 40);
    expect(bestCandidate([only])).toBe(only);
  });

  it("picks the best matched fraction, not the most matches", () => {
    const best = cand(2, 10, 9);
    expect(bestCandidate([cand(1, 48, 40), best, cand(3, 48, 30)])).toBe(best);
  });

  it("is null when the top two tie on fraction", () => {
    expect(bestCandidate([cand(1, 48, 48), cand(2, 10, 10), cand(3, 48, 20)])).toBeNull();
    expect(bestCandidate([cand(1, 20, 10), cand(2, 48, 24)])).toBeNull();
  });

  it("offers the top when a tie sits lower down", () => {
    const best = cand(1, 48, 48);
    expect(bestCandidate([cand(2, 48, 20), best, cand(3, 10, 4)])).toBe(best);
  });

  it("does not mutate its input", () => {
    const list = [cand(1, 48, 20), cand(2, 48, 40)];
    bestCandidate(list);
    expect(list.map((c) => c.root_id)).toEqual([1, 2]);
  });

  it("reads a zero sample as no match", () => {
    const best = cand(2, 10, 3);
    expect(bestCandidate([cand(1, 0, 0), best])).toBe(best);
  });
});
