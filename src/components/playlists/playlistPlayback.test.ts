// -- Test Imports --
import { describe, expect, it } from "vitest";

// -- Unit Imports --
import { expandPlaylist, groupMembers } from "./playlistExpand";
import { hasPlayableSlot } from "./playlistPlayback";
import { entryRow, memberRow, slotRow } from "./playlistTestRows";

const GONE = 1700000000;

describe("hasPlayableSlot", () => {
  const entries = (slots: ReturnType<typeof slotRow>[]) =>
    expandPlaylist(slots, [], new Map(), { orgReady: true }).entries;

  it("is false for an empty playlist", () => {
    expect(hasPlayableSlot(entries([]))).toBe(false);
  });

  it("is false when every source is gone", () => {
    expect(hasPlayableSlot(entries([slotRow(1, 1, 1, GONE), slotRow(2, 2, 2, GONE)]))).toBe(false);
  });

  it("is true when one source is present among gone ones", () => {
    expect(hasPlayableSlot(entries([slotRow(1, 1, 1, GONE), slotRow(2, 2, 2)]))).toBe(true);
  });

  it("counts a present member of an album entry", () => {
    const members = groupMembers([memberRow(5, 50, 1, 1, GONE), memberRow(5, 51, 1, 2)]);
    const expansion = expandPlaylist([], [entryRow(1, 1, 5, false)], members, { orgReady: true });
    expect(hasPlayableSlot(expansion.entries)).toBe(true);
  });

  it("is false when every member of an album entry is gone", () => {
    const members = groupMembers([memberRow(5, 50, 1, 1, GONE)]);
    const expansion = expandPlaylist([], [entryRow(1, 1, 5, false)], members, { orgReady: true });
    expect(hasPlayableSlot(expansion.entries)).toBe(false);
  });
});
