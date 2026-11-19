// -- Test Imports --
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// -- State Imports --
import { useAppStore } from "../store";
import { useOrganizeStore } from "../organize/store";
import { usePlaylistsStore } from "../playlists/store";
import { bindLibrarySink, diffOrg, unbindLibrarySink } from "./libraryWatch";

// -- IPC Imports --
import * as ipc from "../../lib/ipc";

// -- Type Imports --
import type { LibraryChange, PlaylistTrackRow, TrackRow } from "../../types";
import type { AlbumRow, AlbumTrackRow } from "../../types";

vi.mock("../../lib/ipc", async (original) => {
  const real = await original<typeof import("../../lib/ipc")>();
  return {
    ...real,
    setTrackEdit: vi.fn(),
    setTrackGenres: vi.fn(),
    setAlbumFields: vi.fn(),
    setPlaylistOrder: vi.fn(),
    listTracks: vi.fn(async () => ({ rows: [] })),
    loadOrganization: vi.fn(async () => ({ albums: [], membership: [], genres: [] })),
    loadPlaylists: vi.fn(async () => ({ playlists: [], tracks: [] })),
  };
});

vi.mock("./libraryWatch", async (original) => {
  const real = await original<typeof import("./libraryWatch")>();
  return { ...real, diffOrg: vi.fn(real.diffOrg) };
});

const flush = () => new Promise((resolve) => setTimeout(resolve, 0));
const FIELDS = { title: "t", artist: null, album: null, album_artist: null, year: null, disc_no: null };

let seen: LibraryChange[] = [];
const sink = (change: LibraryChange) => seen.push(change);

beforeEach(() => {
  seen = [];
  vi.clearAllMocks();
  useAppStore.setState({ tracks: [{ id: 1, genre_ids: [] } as unknown as TrackRow, { id: 2, genre_ids: [] } as unknown as TrackRow] });
  useOrganizeStore.setState({
    org: {
      albums: [{ id: 7, title: "a", album_artist: null, year: null, genre: null, track_count: 1 } as AlbumRow],
      membership: [{ album_id: 7, track_id: 1, genre_ids: [] } as unknown as AlbumTrackRow],
    },
    orgReady: true,
    past: [],
    future: [],
  });
  usePlaylistsStore.setState({
    ready: true,
    tracks: [
      { id: 1, playlist_id: 3, position: 1 } as PlaylistTrackRow,
      { id: 2, playlist_id: 3, position: 2 } as PlaylistTrackRow,
    ],
  });
});

afterEach(() => unbindLibrarySink(sink));

describe("a write reports again once it has landed", () => {
  it("editTrack reports its id on success only", async () => {
    bindLibrarySink(sink);
    vi.mocked(ipc.setTrackEdit).mockResolvedValueOnce();
    await useAppStore.getState().editTrack(1, FIELDS);
    expect(seen).toEqual([{ track_ids: [1], albums: false, playlists: false }]);

    seen = [];
    vi.mocked(ipc.setTrackEdit).mockRejectedValueOnce(new Error("disk"));
    await useAppStore.getState().editTrack(1, FIELDS);
    expect(seen).toEqual([]);
  });

  it("setTrackGenres reports its id on success only", async () => {
    bindLibrarySink(sink);
    vi.mocked(ipc.setTrackGenres).mockResolvedValueOnce();
    await useAppStore.getState().setTrackGenres(2, [4]);
    expect(seen).toEqual([{ track_ids: [2], albums: false, playlists: false }]);

    seen = [];
    vi.mocked(ipc.setTrackGenres).mockRejectedValueOnce(new Error("disk"));
    await useAppStore.getState().setTrackGenres(2, [5]);
    expect(seen).toEqual([]);
  });

  it("an organize commit reports the album and its members, and undo reports again", async () => {
    bindLibrarySink(sink);
    vi.mocked(ipc.setAlbumFields).mockResolvedValue();
    useOrganizeStore.getState().commitAlbumFields(7, { title: "b", album_artist: null, year: null, genre: null });
    await flush();
    expect(seen).toEqual([{ track_ids: [1], albums: true, playlists: false }]);

    seen = [];
    useOrganizeStore.getState().undo();
    await flush();
    expect(seen).toEqual([{ track_ids: [1], albums: true, playlists: false }]);
  });

  it("an organize commit that fails reports nothing", async () => {
    bindLibrarySink(sink);
    vi.mocked(ipc.setAlbumFields).mockRejectedValueOnce(new Error("disk"));
    useOrganizeStore.getState().commitAlbumFields(7, { title: "b", album_artist: null, year: null, genre: null });
    await flush();
    expect(seen).toEqual([]);
  });

  it("a genre mutation reports the track on success only", async () => {
    bindLibrarySink(sink);
    vi.mocked(ipc.setTrackGenres).mockResolvedValueOnce();
    useOrganizeStore.getState().setTrackGenres(1, [9]);
    await flush();
    expect(seen).toEqual([{ track_ids: [1], albums: true, playlists: false }]);

    seen = [];
    vi.mocked(ipc.setTrackGenres).mockRejectedValueOnce(new Error("disk"));
    useOrganizeStore.getState().setTrackGenres(1, [8]);
    await flush();
    expect(seen).toEqual([]);
  });

  it("a playlist reorder reports the playlist scope on success only", async () => {
    bindLibrarySink(sink);
    vi.mocked(ipc.setPlaylistOrder).mockResolvedValueOnce();
    usePlaylistsStore.getState().reorder(3, [2, 1]);
    await flush();
    expect(seen).toEqual([{ track_ids: [], albums: false, playlists: true }]);

    seen = [];
    vi.mocked(ipc.setPlaylistOrder).mockRejectedValueOnce(new Error("disk"));
    usePlaylistsStore.getState().reorder(3, [1, 2]);
    await flush();
    expect(seen).toEqual([]);
  });

  it("computes no organize diff while no watch is listening", async () => {
    vi.mocked(ipc.setAlbumFields).mockResolvedValue();
    useOrganizeStore.getState().commitAlbumFields(7, { title: "c", album_artist: null, year: null, genre: null });
    useOrganizeStore.getState().undo();
    vi.mocked(ipc.setTrackGenres).mockResolvedValue();
    useOrganizeStore.getState().setTrackGenres(1, [3]);
    await flush();
    expect(diffOrg).not.toHaveBeenCalled();
    expect(seen).toEqual([]);
  });
});
