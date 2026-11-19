// -- Test Imports --
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

// -- Unit Imports --
import { usePlaylistAdd } from "./usePlaylistAdd";
import type { PlaylistAdd } from "./usePlaylistAdd";
import { notReadyError } from "../../lib/ipc";

const h = vi.hoisted(() => ({
  addAlbums: vi.fn(async () => {}),
  addTracks: vi.fn(async () => {}),
  albumAdded: vi.fn(),
  add: null as unknown as (playlistId: number, add: PlaylistAdd) => Promise<void>,
}));

vi.mock("../../state/playlists/store", () => ({
  useAddAlbumsToPlaylist: () => h.addAlbums,
  useAddTracksToPlaylist: () => h.addTracks,
  usePlaylistsStore: { getState: () => ({ playlists: [{ id: 1, name: "Night Drive" }] }) },
}));
vi.mock("../../state/player/queueToast", () => ({ albumAdded: h.albumAdded }));

function Probe() {
  h.add = usePlaylistAdd();
  return null;
}

beforeEach(() => {
  vi.clearAllMocks();
  h.addAlbums.mockImplementation(async () => {});
  h.addTracks.mockImplementation(async () => {});
  renderToStaticMarkup(<Probe />);
});

describe("usePlaylistAdd", () => {
  it("adds albums as entries that keep their order, and names the playlist in the pill", async () => {
    await h.add(1, { kind: "albums", albumIds: [4, 2] });
    expect(h.addAlbums).toHaveBeenCalledWith(1, [4, 2], true);
    expect(h.addTracks).not.toHaveBeenCalled();
    expect(h.albumAdded).toHaveBeenCalledWith("Night Drive");
  });

  it("adds tracks as tracks, with no pill", async () => {
    await h.add(1, { kind: "tracks", trackIds: [8, 9] });
    expect(h.addTracks).toHaveBeenCalledWith(1, [8, 9]);
    expect(h.addAlbums).not.toHaveBeenCalled();
    expect(h.albumAdded).not.toHaveBeenCalled();
  });

  it("shows no pill and rejects nothing when the album add fails", async () => {
    h.addAlbums.mockRejectedValue(new Error("write failed"));
    await expect(h.add(1, { kind: "albums", albumIds: [4] })).resolves.toBeUndefined();
    expect(h.albumAdded).not.toHaveBeenCalled();
  });

  it("shows no pill and rejects nothing when the add is refused before the playlists load", async () => {
    h.addAlbums.mockRejectedValue(notReadyError());
    await expect(h.add(1, { kind: "albums", albumIds: [4] })).resolves.toBeUndefined();
    expect(h.albumAdded).not.toHaveBeenCalled();
  });

  it("rejects nothing when the track add fails", async () => {
    h.addTracks.mockRejectedValue(new Error("write failed"));
    await expect(h.add(1, { kind: "tracks", trackIds: [8] })).resolves.toBeUndefined();
  });
});
