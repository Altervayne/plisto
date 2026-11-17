// -- Test Imports --
import { describe, expect, it, vi } from "vitest";

// -- Unit Imports --
import { diffLibrary, reportLibraryChange } from "./libraryWatch";
import { startLibraryWatch } from "./useLibraryWatch";

// -- Type Imports --
import type { LibraryWatchDeps } from "./useLibraryWatch";
import type { LibrarySnapshot } from "./libraryWatch";
import type { TrackRow } from "../../types";

const track = (id: number): TrackRow => ({ id }) as TrackRow;
const EMPTY: LibrarySnapshot = {
  tracks: [],
  albums: [],
  membership: [],
  playlists: [],
  slots: [],
  albumEntries: [],
};

function setup(initial: TrackRow[]) {
  let snapshot: LibrarySnapshot = { ...EMPTY, tracks: initial };
  let listener: (() => void) | null = null;
  const queue: (() => void)[] = [];
  const diff = vi.fn(diffLibrary);
  const report = vi.fn((): Promise<void> => Promise.resolve());
  const deps: LibraryWatchDeps = {
    read: () => snapshot,
    subscribe: (fn) => {
      listener = fn;
      return () => {
        listener = null;
      };
    },
    diff,
    report,
    defer: (run) => queue.push(run),
  };
  return {
    deps,
    diff,
    report,
    hasListener: () => listener !== null,
    set: (tracks: TrackRow[]) => {
      snapshot = { ...EMPTY, tracks };
      listener?.();
    },
    drain: () => queue.splice(0).forEach((run) => run()),
  };
}

describe("startLibraryWatch", () => {
  it("batches changes inside one microtask into one call", () => {
    const rows = [track(1), track(2), track(3)];
    const { deps, report, set, drain } = setup(rows);
    startLibraryWatch(true, deps);
    set([{ ...rows[0] }, rows[1], rows[2]]);
    set([{ ...rows[0] }, { ...rows[1] }, rows[2]]);
    expect(report).not.toHaveBeenCalled();
    drain();
    expect(report).toHaveBeenCalledTimes(1);
    expect(report).toHaveBeenCalledWith({ track_ids: [1, 2], albums: false, playlists: false });
  });

  it("is silent while the runtime is not ready", () => {
    const rows = [track(1), track(2)];
    const { deps, report, set, drain, hasListener } = setup(rows);
    startLibraryWatch(false, deps);
    expect(hasListener()).toBe(false);
    set([{ ...rows[0] }, rows[1]]);
    drain();
    expect(report).not.toHaveBeenCalled();
  });

  it("reports nothing after teardown", () => {
    const rows = [track(1), track(2)];
    const { deps, report, set, drain, hasListener } = setup(rows);
    const stop = startLibraryWatch(true, deps);
    set([{ ...rows[0] }, rows[1]]);
    stop();
    drain();
    expect(hasListener()).toBe(false);
    expect(report).not.toHaveBeenCalled();
  });

  it("swallows a failed report", async () => {
    const rows = [track(1), track(2)];
    const { deps, report, set, drain } = setup(rows);
    report.mockRejectedValueOnce(new Error("not serving"));
    startLibraryWatch(true, deps);
    set([{ ...rows[0] }, rows[1]]);
    drain();
    await Promise.resolve();
    expect(report).toHaveBeenCalledTimes(1);
  });

  it("batches an explicit report with a diff into one call", () => {
    const rows = [track(1), track(2), track(3)];
    const { deps, report, set, drain } = setup(rows);
    const stop = startLibraryWatch(true, deps);
    set([{ ...rows[0] }, rows[1], rows[2]]);
    reportLibraryChange({ track_ids: [3], albums: true, playlists: false });
    drain();
    expect(report).toHaveBeenCalledTimes(1);
    expect(report).toHaveBeenCalledWith({ track_ids: [1, 3], albums: true, playlists: false });
    stop();
  });

  it("lets a null report absorb the ids", () => {
    const { deps, report, drain } = setup([track(1)]);
    const stop = startLibraryWatch(true, deps);
    reportLibraryChange({ track_ids: [1], albums: false, playlists: false });
    reportLibraryChange({ track_ids: null, albums: false, playlists: false });
    drain();
    expect(report).toHaveBeenCalledWith({ track_ids: null, albums: false, playlists: false });
    stop();
  });

  it("is silent for an explicit report while not ready or after teardown", () => {
    const { deps, report, drain } = setup([track(1)]);
    startLibraryWatch(false, deps);
    reportLibraryChange({ track_ids: [1], albums: false, playlists: false });
    const stop = startLibraryWatch(true, deps);
    stop();
    reportLibraryChange({ track_ids: [1], albums: false, playlists: false });
    drain();
    expect(report).not.toHaveBeenCalled();
  });

  it("does no diff work for a store change that touches no watched array", () => {
    const rows = [track(1), track(2)];
    const { deps, diff, report, set, drain } = setup(rows);
    startLibraryWatch(true, deps);
    set(rows);
    set(rows);
    drain();
    expect(diff).not.toHaveBeenCalled();
    expect(report).not.toHaveBeenCalled();
  });

  it("keeps a newer watch's sink when an older one tears down late", () => {
    const rows = [track(1)];
    const older = setup(rows);
    const newer = setup(rows);
    const stopOlder = startLibraryWatch(true, older.deps);
    startLibraryWatch(true, newer.deps);
    stopOlder();
    reportLibraryChange({ track_ids: [1], albums: false, playlists: false });
    newer.drain();
    expect(newer.report).toHaveBeenCalledTimes(1);
  });
});
