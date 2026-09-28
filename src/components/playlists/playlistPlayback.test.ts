// -- Test Imports --
import { describe, expect, it } from "vitest";

// -- Unit Imports --
import { hasPlayableSlot, playlistQueue } from "./playlistPlayback";

/** A slot with only the fields the play math reads. */
function slot(track_id: number, position: number, missing_at: number | null = null) {
  return { track_id, position, missing_at };
}

describe("playlistQueue", () => {
  it("queues the tracks in slot order, not array order", () => {
    expect(playlistQueue([slot(30, 3), slot(10, 1), slot(20, 2)])).toEqual([10, 20, 30]);
  });

  it("queues a repeated track once per slot", () => {
    expect(playlistQueue([slot(7, 1), slot(8, 2), slot(7, 3)])).toEqual([7, 8, 7]);
  });

  it("keeps a gone source in its place", () => {
    expect(playlistQueue([slot(1, 1, 1700000000), slot(2, 2)])).toEqual([1, 2]);
  });

  it("leaves the input order untouched", () => {
    const slots = [slot(2, 2), slot(1, 1)];
    playlistQueue(slots);
    expect(slots.map((s) => s.track_id)).toEqual([2, 1]);
  });

  it("is empty for an empty playlist", () => {
    expect(playlistQueue([])).toEqual([]);
  });
});

describe("hasPlayableSlot", () => {
  it("is false for an empty playlist", () => {
    expect(hasPlayableSlot([])).toBe(false);
  });

  it("is false when every source is gone", () => {
    expect(hasPlayableSlot([slot(1, 1, 1700000000), slot(2, 2, 1700000000)])).toBe(false);
  });

  it("is true when one source is present among gone ones", () => {
    expect(hasPlayableSlot([slot(1, 1, 1700000000), slot(2, 2)])).toBe(true);
  });
});
