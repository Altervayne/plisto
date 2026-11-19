// -- Test Imports --
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

// -- Unit Imports --
import { BrowseRecordMenu } from "./BrowseRecordMenu";

// -- Type Imports --
import type { MenuEntry } from "../../common/ContextMenu";
import type { RecordActions } from "./useRecordActions";
import type { AlbumRow } from "../../../types";

const h = vi.hoisted(() => ({ items: [] as MenuEntry[], blocked: false }));

vi.mock("../../organize/useWriteGate", () => ({
  useWriteGate: () => ({ blocked: h.blocked, tip: h.blocked ? "Available once loaded" : undefined }),
}));

vi.mock("../../common/ContextMenu", () => ({
  ContextMenu: (p: { items: MenuEntry[] }) => {
    h.items = p.items;
    return null;
  },
}));
vi.mock("../../playlists/PlaylistPicker", () => ({ PlaylistPicker: () => null }));
vi.mock("../../playlists/usePlaylistAdd", () => ({ usePlaylistAdd: () => async () => {} }));
vi.mock("../../../state/playlists/store", () => ({
  usePlaylists: () => [],
  useCreatePlaylist: () => async () => 1,
}));
vi.mock("../../player/visualizers/contextPicker/visualizerMenuItem", () => ({
  visualizerMenuItem: () => null,
}));

const album = (kind: "album" | "single"): AlbumRow => ({
  id: 7,
  title: "Low Tide Radio",
  album_artist: "Ines Varga",
  year: 2022,
  genre: null,
  cover_id: null,
  kind,
  track_count: 9,
  created_at: 0,
  updated_at: 0,
});

const actions = { tracks: [] } as unknown as RecordActions;

const labels = (kind: "album" | "single") => {
  renderToStaticMarkup(
    <BrowseRecordMenu
      album={album(kind)}
      at={{ x: 0, y: 0 }}
      actions={actions}
      player
      organize
      onClose={() => {}}
    />,
  );
  return h.items.map((e) => ("separator" in e ? "-" : e.label));
};

beforeEach(() => {
  h.items = [];
  h.blocked = false;
});

describe("BrowseRecordMenu add to playlist", () => {
  it("words an album's add as the whole album", () => {
    const names = labels("album");
    expect(names).toContain("Add album to playlist...");
    expect(names).not.toContain("Add to playlist...");
  });

  it("keeps a single's add as a plain track add", () => {
    const names = labels("single");
    expect(names).toContain("Add to playlist...");
    expect(names).not.toContain("Add album to playlist...");
  });

  it("disables the add with the tooltip while albums and playlists have not loaded", () => {
    h.blocked = true;
    labels("album");
    const entry = h.items.find(
      (e): e is Exclude<MenuEntry, { separator: true }> =>
        !("separator" in e) && e.label === "Add album to playlist...",
    );
    expect(entry?.disabled).toBe(true);
    expect(entry?.tooltip).toBe("Available once loaded");
  });
});
