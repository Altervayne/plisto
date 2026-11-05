// -- Test Imports --
import { describe, expect, it } from "vitest";

// -- Unit Imports --
import { buildResumeBlob, normalizeResume } from "./resume";

// -- Type Imports --
import type { PlayerStatus } from "../../types";

const blob = (over: Record<string, unknown> = {}): string =>
  JSON.stringify({ v: 1, ids: [3, 5, 8], current_id: 5, secs: 61.5, volume: 0.4, repeat: "all", ...over });

const status = (over: Partial<PlayerStatus> = {}): PlayerStatus => ({
  playing: false,
  track_id: 5,
  position_secs: 61.5,
  duration_secs: 200,
  volume: 0.4,
  repeat: "all",
  queue_index: 1,
  queue_len: 3,
  shuffle: false,
  output_device: null,
  ...over,
});

describe("normalizeResume", () => {
  it("restores a well-formed blob", () => {
    expect(normalizeResume(blob())).toEqual({
      ids: [3, 5, 8],
      currentId: 5,
      secs: 61.5,
      volume: 0.4,
      repeat: "all",
    });
  });

  it("restores nothing for an absent, unreadable or foreign blob", () => {
    expect(normalizeResume(null)).toBeNull();
    expect(normalizeResume("not json")).toBeNull();
    expect(normalizeResume("[]")).toBeNull();
  });

  it("restores nothing for an unknown version", () => {
    expect(normalizeResume(blob({ v: 2 }))).toBeNull();
    expect(normalizeResume(blob({ v: undefined }))).toBeNull();
  });

  it("drops ad-hoc ids", () => {
    expect(normalizeResume(blob({ ids: [-1, 3, 5, -4] }))?.ids).toEqual([3, 5]);
  });

  it("restores nothing when the current id is missing or ad-hoc", () => {
    expect(normalizeResume(blob({ current_id: 99 }))).toBeNull();
    expect(normalizeResume(blob({ ids: [-2, 3], current_id: -2 }))).toBeNull();
  });

  it("clamps the position to zero and defaults a bad one", () => {
    expect(normalizeResume(blob({ secs: -12 }))?.secs).toBe(0);
    expect(normalizeResume(blob({ secs: "x" }))?.secs).toBe(0);
  });

  it("clamps the volume into 0..1", () => {
    expect(normalizeResume(blob({ volume: 3 }))?.volume).toBe(1);
    expect(normalizeResume(blob({ volume: -1 }))?.volume).toBe(0);
    expect(normalizeResume(blob({ volume: undefined }))?.volume).toBe(1);
  });

  it("reads an unknown repeat as off", () => {
    expect(normalizeResume(blob({ repeat: "loop" }))?.repeat).toBe("off");
    expect(normalizeResume(blob({ repeat: undefined }))?.repeat).toBe("off");
  });
});

describe("buildResumeBlob", () => {
  it("snapshots a library session", () => {
    expect(buildResumeBlob(status(), [3, 5, 8])).toEqual({
      v: 1,
      ids: [3, 5, 8],
      current_id: 5,
      secs: 61.5,
      volume: 0.4,
      repeat: "all",
    });
  });

  it("skips an ad-hoc current track", () => {
    expect(buildResumeBlob(status({ track_id: -3 }), [-3])).toBeNull();
  });

  it("skips when nothing is loaded", () => {
    expect(buildResumeBlob(status({ track_id: null }), [3, 5])).toBeNull();
  });

  it("skips while the queue mirror lags the current track", () => {
    expect(buildResumeBlob(status(), [])).toBeNull();
  });

  it("leaves ad-hoc ids out of the saved queue", () => {
    expect(buildResumeBlob(status(), [-1, 5, 8])?.ids).toEqual([5, 8]);
  });
});
