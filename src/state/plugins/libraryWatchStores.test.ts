// -- Test Imports --
import { describe, expect, it, vi } from "vitest";

// -- Unit Imports --
import { browserLibraryWatchDeps, startLibraryWatch } from "./useLibraryWatch";

// -- State Imports --
import { useAppStore } from "../store";
import { useOrganizeStore } from "../organize/store";
import { usePlaylistsStore } from "../playlists/store";

// -- Type Imports --
import type { PlaylistRow, TrackRow } from "../../types";

vi.mock("../../lib/ipc", () => ({
  pluginLibraryChanged: vi.fn(() => Promise.resolve()),
}));

describe("browserLibraryWatchDeps", () => {
  it("reads and watches the three real stores", () => {
    const deps = browserLibraryWatchDeps();
    const rows = [{ id: 1 }, { id: 2 }] as TrackRow[];
    useAppStore.setState({ tracks: rows });
    const report = vi.fn((): Promise<void> => Promise.resolve());
    const queue: (() => void)[] = [];
    const stop = startLibraryWatch(true, { ...deps, report, defer: (run) => queue.push(run) });

    useAppStore.setState({ tracks: [{ ...rows[0] }, rows[1]] });
    usePlaylistsStore.setState({ playlists: [{ id: 9 } as PlaylistRow] });
    useOrganizeStore.setState({ error: "unrelated" });
    queue.splice(0).forEach((run) => run());
    stop();

    expect(report).toHaveBeenCalledTimes(1);
    expect(report).toHaveBeenCalledWith({ track_ids: [1], albums: false, playlists: true });
  });
});
