// -- Test Imports --
import { describe, expect, it } from "vitest";

// -- Unit Imports --
import {
  entryQueue,
  hasPlayableMember,
  memberTitle,
  missingCount,
  totalSecs,
} from "./albumEntryPlay";
import { expandPlaylist, groupMembers } from "./playlistExpand";
import { entryRow, memberRow } from "./playlistTestRows";
import type { AlbumEntry } from "./albumEntryPlay";

const albumEntry = (keep: boolean, missing: number[] = []): AlbumEntry => {
  const members = [
    { ...memberRow(5, 50, 1, 1, missing.includes(50) ? 1 : null), duration_secs: 200 },
    { ...memberRow(5, 51, 1, 2, missing.includes(51) ? 1 : null), duration_secs: 100 },
  ];
  const expansion = expandPlaylist([], [entryRow(2, 1, 5, keep)], groupMembers(members), {
    orgReady: true,
  });
  return expansion.entries[0] as AlbumEntry;
};

describe("entryQueue", () => {
  it("queues every member and a kept entry as one block", () => {
    expect(entryQueue(albumEntry(true))).toEqual({ ids: [50, 51], blocks: [[0, 2]] });
  });

  it("sends no block for an entry that is not kept", () => {
    expect(entryQueue(albumEntry(false))).toEqual({ ids: [50, 51], blocks: undefined });
  });

  it("keeps a missing member in the slice: the engine drops it and moves the spans", () => {
    expect(entryQueue(albumEntry(true, [50])).ids).toEqual([50, 51]);
  });
});

describe("member tallies", () => {
  it("counts the members whose file is gone", () => {
    expect(missingCount(albumEntry(true, [51]).members)).toBe(1);
    expect(missingCount(albumEntry(true).members)).toBe(0);
  });

  it("is playable while any member is present", () => {
    expect(hasPlayableMember(albumEntry(true, [50]).members)).toBe(true);
    expect(hasPlayableMember(albumEntry(true, [50, 51]).members)).toBe(false);
  });

  it("sums the length of the present members only", () => {
    expect(totalSecs(albumEntry(true).members)).toBe(300);
    expect(totalSecs(albumEntry(true, [50]).members)).toBe(100);
    expect(totalSecs(albumEntry(true, [50, 51]).members)).toBeNull();
  });
});

describe("memberTitle", () => {
  it("prefers the edit, then the raw tag, then the filename", () => {
    const base = { ...memberRow(5, 50, 1, 1), filename: "01 a.flac" };
    expect(memberTitle({ ...base, title_override: "Edited", raw_title: "Raw" })).toBe("Edited");
    expect(memberTitle({ ...base, raw_title: "Raw" })).toBe("Raw");
    expect(memberTitle({ ...base, raw_title: "" })).toBe("01 a.flac");
  });
});
