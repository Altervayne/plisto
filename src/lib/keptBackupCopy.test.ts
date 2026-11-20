// -- Test Imports --
import { describe, expect, it } from "vitest";

// -- Unit Imports --
import { keptRowMeta, keptUndoBody } from "./keptBackupCopy";

// -- i18n Imports --
import { createT } from "../i18n";

// -- Type Imports --
import type { KeptBackup } from "../types";

const backup = (over: Partial<KeptBackup> = {}): KeptBackup => ({
  undoId: 1,
  trackId: 2,
  rootId: 3,
  title: "Nuit blanche",
  relPath: "a/b.opus",
  rootLabel: "Music",
  size: 10 * 1024 * 1024,
  keptAt: 0,
  expiresAt: null,
  originalDurationMs: 261_000,
  trimmedDurationMs: 238_000,
  state: "kept",
  canUndo: true,
  ...over,
});

describe("keptRowMeta", () => {
  it("names the trim when both lengths are known", () => {
    expect(keptRowMeta(createT("en"), backup(), "today")).toBe("Trimmed 4:21 to 3:58 - original 10 MB");
  });

  it("falls back to the size and age when either length is missing", () => {
    expect(keptRowMeta(createT("en"), backup({ trimmedDurationMs: null }), "today")).toBe(
      "Original 10 MB - kept today",
    );
    expect(keptRowMeta(createT("fr"), backup({ originalDurationMs: null }), "aujourd'hui")).toBe(
      "Original 10 MB - conservé aujourd'hui",
    );
  });
});

describe("keptUndoBody", () => {
  it("states both lengths, or the plain sentence without them", () => {
    expect(keptUndoBody(createT("en"), backup())).toContain("(3:58) is replaced by the original (4:21)");
    expect(keptUndoBody(createT("en"), backup({ originalDurationMs: null }))).toBe(
      "The trimmed file is replaced by the original. The trimmed version is not kept.",
    );
  });
});
