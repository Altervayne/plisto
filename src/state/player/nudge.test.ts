// -- Test Imports --
import { describe, expect, it } from "vitest";

// -- Unit Imports --
import { SEEK_STEP, VOLUME_STEP, nudgeSeek, nudgeVolume } from "./nudge";

describe("nudgeSeek", () => {
  it("steps the playhead by the seek step either way", () => {
    expect(nudgeSeek(60, 200, SEEK_STEP)).toBe(65);
    expect(nudgeSeek(60, 200, -SEEK_STEP)).toBe(55);
  });

  it("clamps at the start and at the track's end", () => {
    expect(nudgeSeek(3, 200, -SEEK_STEP)).toBe(0);
    expect(nudgeSeek(198, 200, SEEK_STEP)).toBe(200);
  });

  it("refuses to seek a track of unknown length", () => {
    expect(nudgeSeek(10, 0, SEEK_STEP)).toBeNull();
    expect(nudgeSeek(10, 0, -SEEK_STEP)).toBeNull();
  });
});

describe("nudgeVolume", () => {
  it("steps the level by the volume step either way", () => {
    expect(nudgeVolume(0.5, VOLUME_STEP)).toBeCloseTo(0.55);
    expect(nudgeVolume(0.5, -VOLUME_STEP)).toBeCloseTo(0.45);
  });

  it("clamps inside 0..1", () => {
    expect(nudgeVolume(0.02, -VOLUME_STEP)).toBe(0);
    expect(nudgeVolume(0.98, VOLUME_STEP)).toBe(1);
    expect(nudgeVolume(1, VOLUME_STEP)).toBe(1);
    expect(nudgeVolume(0, -VOLUME_STEP)).toBe(0);
  });
});
