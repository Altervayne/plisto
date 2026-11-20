// -- Test Imports --
import { describe, expect, it } from "vitest";

// -- Type Imports --
import type { StreamStatus } from "../types";

// -- Unit Imports --
import {
  analysisStale,
  driveOf,
  inUseIds,
  isCancelledRejection,
  reachBlock,
  blockFailure,
  replaceBlock,
  rootOfPath,
  trackInUse,
  trimFailureOf,
} from "./trimReplace";
import type { ReplaceInput, ReplaceTrack } from "./trimReplace";

const ROOTS = [
  { id: 1, path: "D:\\Music" },
  { id: 2, path: "E:\\Archive\\" },
  { id: 3, path: "D:\\Music\\Live" },
];

const track = (over: Partial<ReplaceTrack> = {}): ReplaceTrack => ({
  source_path: "D:\\Music\\Camille Vautrin\\04 Nuit blanche.opus",
  ext: "opus",
  missing_at: null,
  ...over,
});

const input = (over: Partial<ReplaceInput> = {}): ReplaceInput => ({
  enabled: true,
  trackId: 7,
  ext: "opus",
  track: track(),
  roots: ROOTS,
  offlineRootIds: [],
  inUse: false,
  stale: false,
  ...over,
});

interface StatusOver {
  playing: boolean;
  track_id: number | null;
  queue_index: number;
  repeat: "off" | "all" | "one";
  stream: StreamStatus | null;
}

const status = (over: Partial<StatusOver> = {}): StatusOver => ({
  playing: false,
  track_id: 7,
  queue_index: 0,
  repeat: "off",
  stream: null,
  ...over,
});

const stream = (parked: number | null): StreamStatus => ({
  live: true,
  seekable: false,
  phase: "playing",
  parked: parked == null ? null : { track_id: parked, secs: 12 },
  parked_cleared: false,
});

describe("replaceBlock", () => {
  it("allows an Opus library track that is reachable and not in use", () => {
    expect(replaceBlock(input())).toBeNull();
  });

  it("points to Settings while the switch is off, whatever else holds", () => {
    expect(replaceBlock(input({ enabled: false, ext: "flac", inUse: true }))).toEqual({ kind: "off" });
  });

  it("refuses every other format, naming it", () => {
    expect(replaceBlock(input({ ext: "flac" }))).toEqual({ kind: "format", format: "FLAC" });
    expect(replaceBlock(input({ ext: "mp3" }))).toEqual({ kind: "format", format: "MP3" });
    expect(replaceBlock(input({ ext: "wav" }))).toEqual({ kind: "format", format: "WAV" });
    expect(replaceBlock(input({ ext: "m4b" }))).toEqual({ kind: "format", format: "M4A" });
  });

  it("refuses a file that is not in the library", () => {
    expect(replaceBlock(input({ track: null }))).toEqual({ kind: "adHoc" });
    expect(replaceBlock(input({ trackId: -3 }))).toEqual({ kind: "adHoc" });
  });

  it("refuses a missing file and a file on an offline folder", () => {
    expect(replaceBlock(input({ track: track({ missing_at: 1 }) }))).toEqual({ kind: "missing" });
    expect(
      replaceBlock(input({ track: track({ source_path: "E:\\Archive\\a.opus" }), offlineRootIds: [2] })),
    ).toEqual({ kind: "offline", folder: "E:\\Archive\\" });
  });

  it("refuses a track in use, then an analysis the row moved on from", () => {
    expect(replaceBlock(input({ inUse: true }))).toEqual({ kind: "inUse" });
    expect(replaceBlock(input({ inUse: true, stale: true }))).toEqual({ kind: "inUse" });
    expect(replaceBlock(input({ stale: true }))).toEqual({ kind: "stale" });
  });
});

describe("reachBlock", () => {
  it("names the offline folder only when the file sits under it", () => {
    expect(reachBlock(track(), ROOTS, [2])).toBeNull();
    expect(reachBlock(track(), ROOTS, [1])).toEqual({ kind: "offline", folder: "D:\\Music" });
  });
});

describe("rootOfPath", () => {
  it("matches case and slash blind, the deepest folder first, never a sibling prefix", () => {
    expect(rootOfPath("d:/music/live/x.opus", ROOTS)?.id).toBe(3);
    expect(rootOfPath("D:\\Music\\x.opus", ROOTS)?.id).toBe(1);
    expect(rootOfPath("D:\\Musical\\x.opus", ROOTS)).toBeNull();
  });
});

describe("inUseIds", () => {
  it("holds the seated track and the next, wrapping only under repeat all", () => {
    expect(inUseIds(status({ track_id: 8, queue_index: 0 }), [8, 7, 9])).toEqual([8, 7]);
    expect(inUseIds(status({ track_id: 9, queue_index: 2 }), [8, 7, 9])).toEqual([9]);
    expect(inUseIds(status({ track_id: 9, queue_index: 2, repeat: "all" }), [8, 7, 9])).toEqual([9, 8]);
  });

  it("never lists a next equal to the current", () => {
    expect(inUseIds(status({ repeat: "all" }), [7])).toEqual([7]);
    expect(inUseIds(status({ track_id: 8, repeat: "one" }), [8, 7])).toEqual([8]);
  });

  it("reads a seated stream's parked track as next", () => {
    expect(inUseIds(status({ track_id: -40, stream: stream(7) }), [7, 9])).toEqual([-40, 7]);
    expect(inUseIds(status({ track_id: -40, stream: stream(null) }), [7, 9])).toEqual([-40]);
  });

  it("reads the queue cursor as current during a preview, and nothing past the queue", () => {
    expect(inUseIds(status({ playing: true, track_id: null, queue_index: 1 }), [8, 7, 9])).toEqual([7, 9]);
    expect(inUseIds(status({ track_id: null, queue_index: 3 }), [8, 7])).toEqual([]);
  });
});

describe("trackInUse", () => {
  it("lets the paused current track through, and the one under a preview", () => {
    expect(trackInUse(status(), [7, 8], 7)).toBe(false);
    expect(trackInUse(status({ playing: true, track_id: null }), [7, 8], 7)).toBe(false);
  });

  it("holds the track while it sounds", () => {
    expect(trackInUse(status({ playing: true }), [7, 8], 7)).toBe(true);
  });

  it("holds the track that plays next, wrapping only under repeat all", () => {
    expect(trackInUse(status({ track_id: 8 }), [8, 7], 7)).toBe(true);
    expect(trackInUse(status({ track_id: 8, queue_index: 1 }), [7, 8], 7)).toBe(false);
    expect(trackInUse(status({ track_id: 8, queue_index: 1, repeat: "all" }), [7, 8], 7)).toBe(true);
  });

  it("lets a one-track queue under repeat all through while paused", () => {
    expect(trackInUse(status({ repeat: "all" }), [7], 7)).toBe(false);
  });

  it("reads repeat one as replaying the current track only", () => {
    expect(trackInUse(status({ track_id: 8, repeat: "one" }), [8, 7], 7)).toBe(false);
  });

  it("holds the track a playing stream parked", () => {
    expect(trackInUse(status({ playing: true, track_id: -40, stream: stream(7) }), [7], 7)).toBe(true);
  });
});

describe("analysisStale", () => {
  it("flags a row whose size or mtime moved on", () => {
    const expect0 = { sizeBytes: 100, mtime: 5 };
    expect(analysisStale(expect0, { size_bytes: 100, mtime: 5 })).toBe(false);
    expect(analysisStale(expect0, { size_bytes: 90, mtime: 5 })).toBe(true);
    expect(analysisStale(expect0, { size_bytes: 100, mtime: 6 })).toBe(true);
  });

  it("does not flag a store row still behind the write the analysis was read after", () => {
    const fresh = { sizeBytes: 80, mtime: 9 };
    const lagging = { sizeBytes: 100, mtime: 5 };
    expect(analysisStale(fresh, { size_bytes: 100, mtime: 5 }, lagging)).toBe(false);
    expect(analysisStale(fresh, { size_bytes: 80, mtime: 9 }, lagging)).toBe(false);
    expect(analysisStale(fresh, { size_bytes: 70, mtime: 12 }, lagging)).toBe(true);
  });
});

describe("blockFailure", () => {
  it("reads a block as the refusal the back end would give", () => {
    expect(blockFailure({ kind: "inUse" })).toBe("inUse");
    expect(blockFailure({ kind: "stale" })).toBe("changed");
    expect(blockFailure({ kind: "offline", folder: "E:" })).toBe("offline");
    expect(blockFailure({ kind: "format", format: "FLAC" })).toBe("unavailable");
  });
});

describe("isCancelledRejection", () => {
  it("takes only the explicit cancel", () => {
    expect(isCancelledRejection({ kind: "cancelled" })).toBe(true);
    expect(isCancelledRejection("cancelled")).toBe(true);
    expect(isCancelledRejection("locked")).toBe(false);
    expect(isCancelledRejection({ kind: "other", code: 5 })).toBe(false);
    expect(isCancelledRejection("cancelledness")).toBe(false);
    expect(isCancelledRejection("cancelled: by the user")).toBe(false);
    expect(isCancelledRejection({ kind: "changed" })).toBe(false);
  });
});

describe("driveOf", () => {
  it("names a drive letter or a network share", () => {
    expect(driveOf("d:\\Music\\a.opus")).toBe("D:");
    expect(driveOf("\\\\nas\\music\\a.opus")).toBe("\\\\nas\\music");
  });
});

describe("trimFailureOf", () => {
  it("reads the kinds the backend names", () => {
    expect(trimFailureOf("locked")).toEqual({ kind: "locked", code: null });
    expect(trimFailureOf("space: not enough room")).toEqual({ kind: "space", code: null });
    expect(trimFailureOf({ kind: "denied" })).toEqual({ kind: "denied", code: null });
  });

  it("reads every refusal kind, never folding one into other", () => {
    for (const kind of ["changed", "inUse", "offline", "missing", "busy", "unavailable"] as const) {
      expect(trimFailureOf({ kind })).toEqual({ kind, code: null });
      expect(trimFailureOf(`${kind}: detail`)).toEqual({ kind, code: null });
    }
    expect(trimFailureOf("cancelled")).toEqual({ kind: "other", code: null });
  });

  it("carries the Windows code of an other failure", () => {
    expect(trimFailureOf("other: 1392")).toEqual({ kind: "other", code: "1392" });
    expect(trimFailureOf({ kind: "other", code: 87 })).toEqual({ kind: "other", code: "87" });
    expect(trimFailureOf("rename failed (os error 1224)")).toEqual({ kind: "other", code: "1224" });
  });

  it("reads a busy lock apart, and anything unknown as other without a code", () => {
    expect(trimFailureOf("a file write is running")).toEqual({ kind: "fileWrite", code: null });
    expect(trimFailureOf("a scan is already running")).toEqual({ kind: "scan", code: null });
    expect(trimFailureOf(new Error("boom"))).toEqual({ kind: "other", code: null });
  });
});
