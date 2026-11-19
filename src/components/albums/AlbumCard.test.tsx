// -- Test Imports --
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

// -- Unit Imports --
import { AlbumCard } from "./AlbumCard";

// -- Type Imports --
import type { MenuEntry } from "../common/ContextMenu";
import type { AlbumRow } from "../../types";

const h = vi.hoisted(() => ({ items: [] as MenuEntry[], blocked: false }));

vi.mock("../organize/useWriteGate", () => ({
  useWriteGate: () => ({ blocked: h.blocked, tip: h.blocked ? "Available once loaded" : undefined }),
}));

vi.mock("../common/ContextMenu", () => ({
  useContextMenu: () => ({ open: false, x: 0, y: 0, close: () => {}, onContextMenu: () => {} }),
  ContextMenu: (p: { items: MenuEntry[] }) => {
    h.items = p.items;
    return null;
  },
}));
vi.mock("../common/Cover/Cover", () => ({ Cover: () => null }));
vi.mock("../common/CoverBadge/CoverBadge", () => ({ CoverBadge: () => null }));
vi.mock("../scan/StaffSpinner", () => ({ StaffSpinner: () => null }));
vi.mock("./CardMeta", () => ({ CardMeta: () => null }));
vi.mock("./AlbumDeleteConfirm", () => ({ AlbumDeleteConfirm: () => null }));
vi.mock("./useAlbumCover", () => ({ useAlbumCover: () => ({ src: null, loading: false }) }));
vi.mock("../player/visualizers/contextPicker/visualizerMenuItem", () => ({
  visualizerMenuItem: () => null,
}));
vi.mock("../../state/organize/store", () => ({
  useAlbumTracks: () => [{ track_id: 31, missing_at: null }, { track_id: 32, missing_at: null }],
  useDeleteAlbum: () => async () => {},
}));
vi.mock("../../state/player/store", () => ({
  useOrganizeEnabled: () => true,
  usePlayerEnabled: () => true,
  usePlayerActions: () => ({ play: () => {}, playNext: () => {}, addToQueue: () => {} }),
}));
vi.mock("../../state/playlists/store", () => ({
  usePlaylistsStore: { getState: () => ({ albumEntries: [] }) },
}));

const album = (kind: "album" | "single"): AlbumRow => ({
  id: 7,
  title: "Low Tide Radio",
  album_artist: "Ines Varga",
  year: 2022,
  genre: null,
  cover_id: null,
  kind,
  track_count: 2,
  created_at: 0,
  updated_at: 0,
});

const choose = (kind: "album" | "single") => {
  const onAddToPlaylist = vi.fn();
  renderToStaticMarkup(
    <AlbumCard
      album={album(kind)}
      selected={false}
      checked={false}
      landed={false}
      selecting={false}
      onOpen={() => {}}
      onToggleSelect={() => {}}
      onExport={() => {}}
      onAddToPlaylist={onAddToPlaylist}
    />,
  );
  const item = h.items.find(
    (e): e is Exclude<MenuEntry, { separator: true }> =>
      !("separator" in e) && e.label.includes("to playlist"),
  );
  item?.onSelect();
  return { label: item?.label, onAddToPlaylist };
};

beforeEach(() => {
  h.items = [];
  h.blocked = false;
  vi.stubGlobal("window", { devicePixelRatio: 1 });
});

describe("AlbumCard add to playlist", () => {
  it("hands an album over as one album entry", () => {
    const { label, onAddToPlaylist } = choose("album");
    expect(label).toBe("Add album to playlist...");
    expect(onAddToPlaylist).toHaveBeenCalledWith({ kind: "albums", albumIds: [7] });
  });

  it("hands a single over as its track", () => {
    const { label, onAddToPlaylist } = choose("single");
    expect(label).toBe("Add to playlist...");
    expect(onAddToPlaylist).toHaveBeenCalledWith({ kind: "tracks", trackIds: [31, 32] });
  });
});

describe("AlbumCard while albums and playlists have not loaded", () => {
  it("disables the add and delete entries with the tooltip", () => {
    h.blocked = true;
    choose("album");
    const gated = h.items.filter(
      (e): e is Exclude<MenuEntry, { separator: true }> =>
        !("separator" in e) && (e.label.includes("to playlist") || e.style === "destructive"),
    );
    expect(gated).toHaveLength(2);
    for (const entry of gated) {
      expect(entry.disabled).toBe(true);
      expect(entry.tooltip).toBe("Available once loaded");
    }
  });
});
