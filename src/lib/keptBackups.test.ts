// -- Test Imports --
import { describe, expect, it } from "vitest";

// -- Unit Imports --
import {
  discardAllNotice,
  discardFailureLine,
  discardOneNotice,
  discardable,
  expiryDays,
  keptForRoot,
  keptForTracks,
  keptRowKind,
  summarizeKept,
  summaryLine,
  undoFailureLine,
} from "./keptBackups";

// -- i18n Imports --
import { createT } from "../i18n";

// -- Type Imports --
import type { KeptBackup } from "../types";

const backup = (over: Partial<KeptBackup> = {}): KeptBackup => ({
  undoId: 1,
  trackId: 10,
  rootId: 3,
  title: "Nuit blanche",
  relPath: "a/b.opus",
  rootLabel: "Music",
  size: 1000,
  keptAt: 0,
  expiresAt: null,
  originalDurationMs: null,
  trimmedDurationMs: null,
  state: "kept",
  canUndo: true,
  ...over,
});

describe("keptForTracks", () => {
  it("keeps the backups of the listed tracks and skips ones whose track is gone", () => {
    const list = [backup({ undoId: 1, trackId: 10 }), backup({ undoId: 2, trackId: 11 }), backup({ undoId: 3, trackId: null })];
    expect(keptForTracks(list, [11, 12]).map((b) => b.undoId)).toEqual([2]);
    expect(keptForTracks(list, [])).toEqual([]);
  });
});

describe("keptForRoot", () => {
  it("keeps the backups under one folder", () => {
    const list = [backup({ undoId: 1, rootId: 3 }), backup({ undoId: 2, rootId: 4 }), backup({ undoId: 3, rootId: null })];
    expect(keptForRoot(list, 3).map((b) => b.undoId)).toEqual([1]);
  });
});

describe("keptRowKind", () => {
  it("reads state first, then whether undo is still allowed", () => {
    expect(keptRowKind(backup({ state: "missing", canUndo: false }))).toBe("missing");
    expect(keptRowKind(backup({ state: "offline" }))).toBe("offline");
    expect(keptRowKind(backup({ canUndo: false }))).toBe("changed");
    expect(keptRowKind(backup())).toBe("ready");
  });

  it("reads a track or folder no longer in the library as not in the library", () => {
    expect(keptRowKind(backup({ trackId: null, canUndo: false }))).toBe("notInLibrary");
    expect(keptRowKind(backup({ rootId: null, canUndo: false }))).toBe("notInLibrary");
  });

  it("lets missing and offline win over a gone track", () => {
    expect(keptRowKind(backup({ trackId: null, state: "missing", canUndo: false }))).toBe("missing");
    expect(keptRowKind(backup({ rootId: null, state: "offline", canUndo: false }))).toBe("offline");
  });
});

describe("summarizeKept and discardable", () => {
  const list = [
    backup({ undoId: 1, size: 100 }),
    backup({ undoId: 2, size: 50, state: "offline" }),
    backup({ undoId: 3, size: 0, state: "missing" }),
  ];
  it("counts the backups on disk, and the missing and offline ones apart", () => {
    expect(summarizeKept(list)).toEqual({ count: 2, bytes: 150, missing: 1, offline: 1 });
  });
  it("offers Discard all only the online backups on disk", () => {
    expect(discardable(list).map((b) => b.undoId)).toEqual([1]);
  });
});

describe("expiryDays", () => {
  const day = 86_400_000;
  it("is null when kept until discarded", () => {
    expect(expiryDays(backup(), 0)).toBeNull();
  });
  it("rounds a partial day up and floors an overdue backup at today", () => {
    expect(expiryDays(backup({ expiresAt: 2.2 * day }), 0)).toBe(3);
    expect(expiryDays(backup({ expiresAt: -5 * day }), 0)).toBe(0);
  });
});

describe("discard notices", () => {
  const t = createT("en");
  it("names the path when one discard left the file in place, and is silent otherwise", () => {
    expect(discardOneNotice(t, backup(), { leftInPlace: true })).toContain("a/b.opus");
    expect(discardOneNotice(t, backup(), { leftInPlace: false })).toBeNull();
  });
  it("joins the left-in-place, offline and failed lines of Discard all", () => {
    expect(discardAllNotice(t, { discarded: 3, leftInPlace: 0, offline: 0, failed: 0 })).toBeNull();
    expect(discardAllNotice(t, { discarded: 1, leftInPlace: 2, offline: 0, failed: 0 })).toBe(
      "2 files changed since Plisto kept them, so they were left in place and only their entries were removed.",
    );
    const both = discardAllNotice(t, { discarded: 1, leftInPlace: 1, offline: 2, failed: 0 });
    expect(both).toContain("1 file changed");
    expect(both).toContain("2 backups on offline folders are kept.");
    expect(discardAllNotice(t, { discarded: 0, leftInPlace: 0, offline: 0, failed: 1 })).toBe(
      "1 backup could not be discarded and is still kept.",
    );
    const all = discardAllNotice(t, { discarded: 0, leftInPlace: 1, offline: 1, failed: 3 });
    expect(all?.endsWith("3 backups could not be discarded and are still kept.")).toBe(true);
    expect(all).toContain("1 file changed");
  });
  it("words a discard refused for an unfinished write apart from a plain failure", () => {
    expect(discardFailureLine(t, new Error("unfinished writes"))).toContain("still unfinished");
    expect(discardFailureLine(t, new Error("disk error"))).toContain("could not be discarded");
  });
});

describe("summaryLine", () => {
  const t = createT("en");
  const list = [
    backup({ undoId: 1, size: 1024 * 1024 }),
    backup({ undoId: 2, size: 1024 * 1024, state: "offline" }),
    backup({ undoId: 3, size: 0, state: "missing" }),
  ];
  it("counts what is on disk, adds the missing and offline ones, and ends on the keep time", () => {
    expect(summaryLine(t, list, 30)).toBe("2 backups - 2.0 MB, 1 missing, 1 offline - kept 30 days");
  });
  it("reads kept until discarded when there is no limit", () => {
    expect(summaryLine(t, [backup()], null)).toBe("1 backup - 1000 B - kept until you discard them");
  });
});

describe("undoFailureLine", () => {
  const t = createT("en");
  const line = (kind: Parameters<typeof undoFailureLine>[1]["kind"], code: string | null = null) =>
    undoFailureLine(t, { kind, code }, backup());
  it("keeps the undo refusal for a changed file only", () => {
    expect(line("changed")).toBe("The file changed since the trim, so Plisto did not put the original back.");
    expect(line("locked")).toContain("has this file open");
    expect(line("locked")).not.toBe(line("changed"));
  });
  it("words every other kind and carries the Windows code", () => {
    expect(line("denied")).toContain("denied access");
    expect(line("space")).toContain("1000 B");
    expect(line("other", "1392")).toContain("1392");
    expect(line("other")).toBe("Windows reported an error");
    expect(line("fileWrite")).toBe("Plisto is writing to your music files. Try again in a moment.");
  });
  it("words a full drive and an unavailable replace for the undo, not the trim", () => {
    expect(line("space")).not.toContain("new file");
    expect(line("unavailable")).toContain("cannot be put back");
    expect(line("unavailable")).not.toContain("new file");
  });
});
