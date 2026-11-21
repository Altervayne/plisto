// -- Test Imports --
import { describe, expect, it } from "vitest";

// -- Unit Imports --
import { createTickBuilder, frameStats } from "./labNetStats";

// -- Type Imports --
import type { SongFrame } from "./labSong";

const song = (beat: number): SongFrame =>
  ({ sig: { beat }, fine: [1, 2], bands: [3, 4], level: { rms: 0, peak: 0, flux: 0 } }) as unknown as SongFrame;

describe("frameStats", () => {
  it("has no reading for an empty run", () => {
    expect(frameStats([])).toBeNull();
  });

  it("takes the middle of an odd run and the mean of the middle two of an even one", () => {
    expect(frameStats([9, 1, 5])).toEqual({ medianMs: 5, worstMs: 9 });
    expect(frameStats([4, 1, 3, 10])).toEqual({ medianMs: 3.5, worstMs: 10 });
  });

  it("does not reorder its input", () => {
    const run = [3, 1, 2];
    frameStats(run);
    expect(run).toEqual([3, 1, 2]);
  });
});

describe("createTickBuilder", () => {
  it("numbers ticks from 1 and carries the song's frame", () => {
    const ticks = createTickBuilder(true);
    const a = ticks.next(song(0), 0, 1 / 60);
    const b = ticks.next(song(0), 1 / 60, 1 / 60);
    expect([a.seq, b.seq]).toEqual([1, 2]);
    expect(b.rawBands).toEqual([3, 4]);
    expect(b.fine).toEqual([1, 2]);
    expect(b.playing).toBe(true);
  });

  it("counts a beat and remembers where the latest one fell", () => {
    const ticks = createTickBuilder(false);
    expect(ticks.next(song(0), 0.1, 0.1).beatAt).toBeNull();
    const hit = ticks.next(song(0.8), 0.2, 0.1);
    expect([hit.nBeats, hit.beatAt]).toEqual([1, 0.2]);
    const after = ticks.next(song(0), 0.3, 0.1);
    expect([after.nBeats, after.beatAt]).toEqual([0, 0.2]);
  });

  it("leaves the fine spectrum out unless the kind draws from it", () => {
    expect(createTickBuilder(false).next(song(0), 0, 1 / 60).fine).toBeNull();
  });
});
