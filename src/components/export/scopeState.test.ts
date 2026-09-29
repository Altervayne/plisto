// -- Test Imports --
import { describe, expect, it } from "vitest";

// -- Unit Imports --
import { scopeState, showsChangedCounts } from "./scopeState";

// -- Type Imports --
import type { ExportChangeSet } from "../../types";

const recorded: ExportChangeSet = {
  has_record: true,
  last_exported_at: 1_750_000_000,
  albums: 2,
  singles: 1,
  playlists: 0,
  files: 14,
  total_files: 120,
};

describe("scopeState", () => {
  it("disables changed-only for a dated snapshot, whatever the scope", () => {
    expect(scopeState("changed", recorded, true, true)).toBe("snapshotDisabled");
    expect(scopeState("all", null, true, true)).toBe("snapshotDisabled");
  });

  it("reads the whole library when the scope is everything", () => {
    expect(scopeState("all", recorded, false, true)).toBe("all");
  });

  it("waits while no preview is in hand", () => {
    expect(scopeState("changed", null, false, true)).toBe("pending");
  });

  it("reads a filled destination with no record, or no stamp, as unrecorded", () => {
    const unrecorded = { ...recorded, has_record: false };
    const unstamped = { ...recorded, last_exported_at: null };
    expect(scopeState("changed", unrecorded, false, true)).toBe("noRecord");
    expect(scopeState("changed", unstamped, false, true)).toBe("noRecord");
  });

  it("reads an empty destination with no record as a first export", () => {
    const fresh = { ...recorded, has_record: false, last_exported_at: null };
    expect(scopeState("changed", fresh, false, false)).toBe("firstExport");
  });

  it("reads zero files to write as nothing changed", () => {
    const none = { ...recorded, albums: 0, singles: 0, files: 0 };
    expect(scopeState("changed", none, false, true)).toBe("nothingChanged");
  });

  it("reads every file to write as everything changed", () => {
    const all = { ...recorded, files: 120 };
    expect(scopeState("changed", all, false, true)).toBe("everythingChanged");
  });

  it("reads a partial diff as changes", () => {
    expect(scopeState("changed", recorded, false, true)).toBe("changes");
  });

  it("keeps an empty library with a record as nothing changed, not everything", () => {
    const empty = { ...recorded, albums: 0, singles: 0, files: 0, total_files: 0 };
    expect(scopeState("changed", empty, false, true)).toBe("nothingChanged");
  });
});

describe("showsChangedCounts", () => {
  it("switches the readiness line only once a recorded preview is in hand", () => {
    expect(showsChangedCounts("changes")).toBe(true);
    expect(showsChangedCounts("everythingChanged")).toBe(true);
    expect(showsChangedCounts("nothingChanged")).toBe(true);
    expect(showsChangedCounts("noRecord")).toBe(false);
    expect(showsChangedCounts("firstExport")).toBe(false);
    expect(showsChangedCounts("pending")).toBe(false);
    expect(showsChangedCounts("all")).toBe(false);
    expect(showsChangedCounts("snapshotDisabled")).toBe(false);
  });
});
