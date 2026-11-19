// -- Test Imports --
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

// -- Unit Imports --
import { AlbumPicker } from "./AlbumPicker";
import { PlaylistPicker } from "../playlists/PlaylistPicker";

const h = vi.hoisted(() => ({ status: "loading" as string }));

// A static render reads a store at its initial state, so the status the pickers follow is set here.
vi.mock("../../state/projectionStatus", () => ({
  useOrgStatus: () => h.status,
  usePlaylistsStatus: () => h.status,
}));
vi.mock("../../state/playlists/expansion", () => ({ usePlaylistTrackCount: () => 0 }));

const NOT_LOADED = "Loading albums and playlists";

const albumPicker = () => renderToStaticMarkup(<AlbumPicker albums={[]} onChoose={() => {}} onClose={() => {}} />);
const playlistPicker = () =>
  renderToStaticMarkup(<PlaylistPicker playlists={[]} onChoose={() => {}} onCreate={() => {}} onClose={() => {}} />);

beforeEach(() => {
  h.status = "loading";
});

describe("the album picker", () => {
  it("shows the pending line, not the empty one, until the albums have loaded", () => {
    const html = albumPicker();
    expect(html).toContain(NOT_LOADED);
    expect(html).not.toContain("No albums yet");
  });

  it("shows the pending line while stalled too", () => {
    h.status = "stalled";
    expect(albumPicker()).toContain(NOT_LOADED);
  });

  it("says there are no albums once loaded and truly empty", () => {
    h.status = "ready";
    const html = albumPicker();
    expect(html).toContain("No albums yet");
    expect(html).not.toContain(NOT_LOADED);
  });
});

describe("the playlist picker", () => {
  it("shows the pending line, with no search or create box, until the playlists have loaded", () => {
    const html = playlistPicker();
    expect(html).toContain(NOT_LOADED);
    expect(html).not.toContain("No playlists yet");
    expect(html).not.toContain("<input");
  });

  it("says there are no playlists once loaded and truly empty", () => {
    h.status = "ready";
    const html = playlistPicker();
    expect(html).toContain("No playlists yet");
    expect(html).not.toContain(NOT_LOADED);
  });
});
