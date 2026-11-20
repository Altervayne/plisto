// -- Test Imports --
import { describe, expect, it } from "vitest";

// -- Unit Imports --
import { groupUnmatched, isBusyRefusal, lostItems, pointKind, shouldClearResult, unmatchedText } from "./restorePointModel";

// -- Type Imports --
import type { RestoreResult } from "../../../state/restorePoints/store";
import type { RestorePointRow, RestoreSummary, UnmatchedGroup } from "../../../types";

const ready = (reason: RestorePointRow["reason"], detail: string | null, version = "2.7.2"): RestorePointRow => ({
  file: "p.sqlite",
  reason,
  created_at: 1_700_000_000_000,
  bytes: 10,
  status: {
    kind: "ready",
    app_version: version,
    detail,
    albums: 1,
    singles: 2,
    playlists: 3,
    filed_tracks: 4,
    edited_tracks: 5,
    genre_tracks: 6,
  },
});

const summary = (over: Partial<RestoreSummary> = {}): RestoreSummary => ({
  albums: 10,
  singles: 4,
  playlists: 2,
  filed_tracks: 100,
  unmatched_tracks: 0,
  albums_not_recreated: 0,
  collapsed: 0,
  dropped_entries: 0,
  cleared_tracks: 0,
  unmatched: [],
  ...over,
});

const group = (kind: UnmatchedGroup["kind"], title: string | null, paths: string[]): UnmatchedGroup => ({
  kind,
  id: title === null ? null : 1,
  title,
  paths,
});

describe("pointKind", () => {
  it("names a version point for the version that made it", () => {
    expect(pointKind(ready("version", "2.7.1"))).toEqual({ reason: "version", version: "2.7.2" });
  });

  it("reads daily and restore points by their reason", () => {
    expect(pointKind(ready("daily", null))).toEqual({ reason: "daily" });
    expect(pointKind(ready("restore", "old.sqlite"))).toEqual({ reason: "restore" });
  });

  it.each(["tags_apply", "merge_duplicates", "delete_albums", "remove_root", "purge", "relocate"])(
    "keeps the %s action",
    (key) => {
      expect(pointKind(ready("action", key))).toEqual({ reason: "action", action: key });
    },
  );

  it("keeps an unknown action as no action, never a raw key", () => {
    expect(pointKind(ready("action", "something_new"))).toEqual({ reason: "action", action: null });
    expect(pointKind(ready("action", null))).toEqual({ reason: "action", action: null });
  });
});

describe("lostItems", () => {
  it("reports nothing lost for a clean restore", () => {
    expect(lostItems(summary())).toEqual({ notFound: 0, notRecreated: 0, cleared: 0, allUnmatched: false });
  });

  it("carries each loss on its own", () => {
    const lost = lostItems(summary({ unmatched_tracks: 12, albums_not_recreated: 3, cleared_tracks: 9 }));
    expect(lost).toEqual({ notFound: 12, notRecreated: 3, cleared: 9, allUnmatched: false });
  });

  it("flags a point none of whose tracks were found", () => {
    expect(lostItems(summary({ filed_tracks: 0, unmatched_tracks: 40 })).allUnmatched).toBe(true);
  });

  it("does not call an empty point all unmatched", () => {
    expect(lostItems(summary({ filed_tracks: 0, unmatched_tracks: 0 })).allUnmatched).toBe(false);
  });
});

describe("result dismissal", () => {
  const busy: RestoreResult = { kind: "refused", file: "a", failure: { key: "busy", detail: null } };
  const failed: RestoreResult = { kind: "refused", file: "a", failure: { key: "failed", detail: "x" } };
  const done = (file: string): RestoreResult => ({ kind: "done", file, summary: summary(), beforePoint: null });

  it("recognises only a scan refusal as busy", () => {
    expect(isBusyRefusal(busy)).toBe(true);
    expect(isBusyRefusal(failed)).toBe(false);
    expect(isBusyRefusal(done("a"))).toBe(false);
    expect(isBusyRefusal(null)).toBe(false);
  });

  it("clears the result a sheet shows, and a scan refusal that replaced it", () => {
    const shown = done("a");
    expect(shouldClearResult(shown, shown)).toBe(true);
    expect(shouldClearResult(shown, busy)).toBe(true);
  });

  it("leaves a newer result, or none, alone", () => {
    const shown = done("a");
    expect(shouldClearResult(shown, done("b"))).toBe(false);
    expect(shouldClearResult(shown, failed)).toBe(false);
    expect(shouldClearResult(shown, null)).toBe(false);
  });
});

describe("groupUnmatched", () => {
  it("files singles under albums and keeps playlists and other apart", () => {
    const grouped = groupUnmatched([
      group("album", "A", ["a"]),
      group("single", "S", ["s"]),
      group("playlist", "P", ["p"]),
      group("other", null, ["o"]),
    ]);
    expect(grouped.albums.map((g) => g.title)).toEqual(["A", "S"]);
    expect(grouped.playlists.map((g) => g.title)).toEqual(["P"]);
    expect(grouped.other).toHaveLength(1);
  });
});

describe("unmatchedText", () => {
  const headings = { albums: "Albums", playlists: "Playlists", other: "Other tracks" };

  it("lists a heading per kind, a title per container and its paths indented", () => {
    const text = unmatchedText(
      [group("album", "Mezzanine", ["D:\\m\\1.flac", "D:\\m\\2.flac"]), group("playlist", "Drive", ["D:\\x.flac"])],
      headings,
    );
    expect(text).toBe("Albums\nMezzanine\n  D:\\m\\1.flac\n  D:\\m\\2.flac\n\nPlaylists\nDrive\n  D:\\x.flac");
  });

  it("lists the paths of tracks in no container flat under their heading", () => {
    expect(unmatchedText([group("other", null, ["D:\\o.flac"])], headings)).toBe("Other tracks\nD:\\o.flac");
  });

  it("is empty when nothing is unmatched", () => {
    expect(unmatchedText([], headings)).toBe("");
  });
});
