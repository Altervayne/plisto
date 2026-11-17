// -- Test Imports --
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

// -- Unit Imports --
import { PlaylistHeader } from "./PlaylistHeader";

// -- Type Imports --
import type { PlaylistRow } from "../../types";

const h = vi.hoisted(() => ({ count: 31, albums: 3 }));

vi.mock("../common/EditableField/EditableField", () => ({ EditableField: () => null }));
vi.mock("./PlaylistCoverField", () => ({ PlaylistCoverField: () => null }));
vi.mock("./PlaylistDescriptionField", () => ({ PlaylistDescriptionField: () => null }));
vi.mock("./PlaylistDeleteControl", () => ({ PlaylistDeleteControl: () => null }));
vi.mock("./PlaylistExportDialog", () => ({ PlaylistExportDialog: () => null }));
vi.mock("./usePlayPlaylist", () => ({ usePlayPlaylist: () => ({ playable: true, play: () => {} }) }));
vi.mock("../../state/player/store", () => ({ usePlayerEnabled: () => true }));
vi.mock("../../state/playlists/store", () => ({
  useRenamePlaylist: () => async () => {},
  useSetPlaylistDescription: () => async () => {},
  usePlaylistAlbumEntries: () => Array.from({ length: h.albums }, (_, i) => ({ id: i })),
}));
vi.mock("../../state/playlists/expansion", () => ({ usePlaylistTrackCount: () => h.count }));

const playlist = { id: 1, name: "Night Drive", description: null, track_count: 6 } as PlaylistRow;
const render = () => renderToStaticMarkup(<PlaylistHeader playlist={playlist} onDeleted={() => {}} />);

beforeEach(() => {
  h.count = 31;
  h.albums = 3;
});

describe("PlaylistHeader count", () => {
  it("counts tracks, albums included, with a tail naming the albums", () => {
    const html = render();
    expect(html).toContain("31 tracks");
    expect(html).toContain(", including 3 albums");
  });

  it("reads one album in the singular", () => {
    h.albums = 1;
    expect(render()).toContain(", including 1 album<");
  });

  it("reads exactly as before for a playlist with no album", () => {
    h.albums = 0;
    const html = render();
    expect(html).toContain("31 tracks");
    expect(html).not.toContain("including");
  });

  it("reads the derived count, not the count the playlists load reported", () => {
    h.count = 12;
    expect(render()).not.toContain("6 tracks");
  });
});
