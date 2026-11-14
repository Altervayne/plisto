// -- Test Imports --
import { describe, expect, it } from "vitest";

// -- Unit Imports --
import { buildResumeBlob, normalizeResume } from "./resume";

// -- Local Imports --
import { streamStatusFixture } from "./streamFixtures";

// -- Type Imports --
import type { PlayerStatus, StreamStatus } from "../../types";

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
  output_taken_over: false,
  stream: null,
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

describe("buildResumeBlob with a stream seated", () => {
  // The stream's own id is the status track id; the parked slot is what the blob describes.
  const seated = (over: Partial<StreamStatus> = {}, rest: Partial<PlayerStatus> = {}) =>
    status({ track_id: -41, position_secs: 3, duration_secs: 0, stream: streamStatusFixture(over), ...rest });

  it("writes the blob it would write with no stream, from the parked slot", () => {
    const parked = { track_id: 5, secs: 61.5 };
    expect(buildResumeBlob(seated({ parked }), [3, 5, 8])).toEqual(buildResumeBlob(status(), [3, 5, 8]));
  });

  it("never writes the stream's ad-hoc id, nor a position tick of the stream", () => {
    const blob = buildResumeBlob(seated({ parked: { track_id: 5, secs: 10 } }, { position_secs: 999 }), [3, 5, -41]);
    expect(blob?.current_id).toBe(5);
    expect(blob?.secs).toBe(10);
    expect(blob?.ids).toEqual([3, 5]);
  });

  it("skips while the queue mirror does not hold the parked track yet", () => {
    expect(buildResumeBlob(seated({ parked: { track_id: 5, secs: 10 } }), [3, 8])).toBeNull();
  });

  it("writes the cleared blob after Clear queue, and normalizeResume reads it as nothing", () => {
    const blob = buildResumeBlob(seated({ parked: null, parked_cleared: true }), []);
    expect(blob).toEqual({ v: 1, ids: [], current_id: 0, secs: 0, volume: 0.4, repeat: "all" });
    expect(normalizeResume(JSON.stringify(blob))).toBeNull();
  });

  it("keeps the saved blob while nothing is parked and nothing is cleared", () => {
    expect(buildResumeBlob(seated({ parked: null, parked_cleared: false }), [3, 5])).toBeNull();
  });
});
