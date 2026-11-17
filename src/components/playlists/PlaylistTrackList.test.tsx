// -- Test Imports --
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactNode } from "react";

// -- Unit Imports --
import { PlaylistTrackList } from "./PlaylistTrackList";
import { expandPlaylist, groupMembers } from "./playlistExpand";
import { entryRow, memberRow, slotRow } from "./playlistTestRows";
import type { PlaylistExpansion } from "./playlistExpand";

interface RowProbe {
  kind: "track" | "album";
  id: number;
  displayNo: number;
  canPlay: boolean;
  play: () => void;
  playFrom?: (member: number) => void;
}

const h = vi.hoisted(() => ({
  expansion: null as unknown as PlaylistExpansion,
  rows: [] as RowProbe[],
  play: vi.fn(),
  playNext: vi.fn(() => ({ afterBlock: false })),
  addToQueue: vi.fn(),
  reorder: vi.fn(),
  removeSlots: vi.fn(async () => {}),
  setKeepOrder: vi.fn(async () => {}),
  unpack: vi.fn(async () => {}),
  unpacked: vi.fn(),
  onDragEnd: null as unknown as (e: unknown) => void,
  albumProps: null as unknown as {
    onSetKeep: (keep: boolean) => void;
    onUnpack: () => void;
    onRemove: () => void;
  },
}));

vi.mock("./PlaylistTrackRow", () => ({
  PlaylistTrackRow: (p: { slot: { id: number }; displayNo: number; onPlay?: () => void }) => {
    h.rows.push({
      kind: "track",
      id: p.slot.id,
      displayNo: p.displayNo,
      canPlay: p.onPlay != null,
      play: p.onPlay ?? (() => {}),
    });
    return <i data-kind="track" />;
  },
}));
vi.mock("./PlaylistAlbumRow", () => ({
  PlaylistAlbumRow: (p: {
    entry: { id: number };
    displayNo: number;
    ready: boolean;
    onPlayFrom: (member: number) => void;
    onSetKeep: (keep: boolean) => void;
    onUnpack: () => void;
    onRemove: () => void;
  }) => {
    h.albumProps = p;
    h.rows.push({
      kind: "album",
      id: p.entry.id,
      displayNo: p.displayNo,
      canPlay: p.ready,
      play: () => p.onPlayFrom(0),
      playFrom: p.onPlayFrom,
    });
    return <i data-kind="album" />;
  },
}));
vi.mock("../../state/playlists/store", () => ({
  usePlaylist: () => ({ id: 1, name: "Night Drive" }),
  useRemovePlaylistSlots: () => h.removeSlots,
  useReorderPlaylist: () => h.reorder,
  useSetEntryKeepOrder: () => h.setKeepOrder,
  useUnpackAlbumEntry: () => h.unpack,
}));
vi.mock("../../state/player/queueToast", () => ({
  announceAfterBlock: () => {},
  unpacked: h.unpacked,
}));
// The drag itself needs a pointer; the list's drop handler is what is under test, so the context hands it over.
vi.mock("@dnd-kit/core", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@dnd-kit/core")>()),
  DndContext: (p: { onDragEnd: (e: unknown) => void; children: ReactNode }) => {
    h.onDragEnd = p.onDragEnd;
    return <>{p.children}</>;
  },
}));
vi.mock("../../state/playlists/expansion", () => ({ usePlaylistExpansion: () => h.expansion }));
vi.mock("../../state/player/store", () => ({
  usePlayerActions: () => ({ play: h.play, playNext: h.playNext, addToQueue: h.addToQueue }),
  usePlayerEnabled: () => true,
}));
vi.mock("../player/visualizers/contextPicker/visualizerMenuItem", () => ({
  visualizerMenuItem: () => null,
}));

const slots = [slotRow(1, 1, 9), slotRow(3, 3, 8)];
const entries = [entryRow(2, 2, 5, true)];
const members = groupMembers([memberRow(5, 50, 1, 1), memberRow(5, 51, 1, 2)]);

const render = () => {
  h.rows = [];
  return renderToStaticMarkup(
    <PlaylistTrackList playlistId={1} onOpenSlot={() => {}} openSlotId={null} onOpenAlbum={() => {}} />,
  );
};

beforeEach(() => {
  vi.clearAllMocks();
  h.removeSlots.mockImplementation(async () => {});
  h.unpack.mockImplementation(async () => {});
  h.expansion = expandPlaylist(slots, entries, members, { orgReady: true });
});

describe("PlaylistTrackList", () => {
  it("lists track slots and album entries together, in position order, numbered by row", () => {
    render();
    expect(h.rows.map((r) => [r.kind, r.id, r.displayNo])).toEqual([
      ["track", 1, 1],
      ["album", 2, 2],
      ["track", 3, 3],
    ]);
  });

  it("plays a row from its index in the expansion, with the blocks", () => {
    render();
    h.rows[2].play();
    // Track 8 sits after track 9 and the album's two members.
    expect(h.play).toHaveBeenCalledWith([9, 50, 51, 8], 3, expect.anything(), [[1, 2]]);
  });

  it("plays from a member of an album entry at that member's index", () => {
    render();
    h.rows[1].playFrom?.(1);
    expect(h.play).toHaveBeenCalledWith([9, 50, 51, 8], 2, expect.anything(), [[1, 2]]);
  });

  it("holds every row's play back while the album projection is loading", () => {
    h.expansion = expandPlaylist(slots, entries, members, { orgReady: false });
    render();
    expect(h.rows.map((r) => r.canPlay)).toEqual([false, false, false]);
    expect(h.rows.map((r) => r.kind)).toEqual(["track", "album", "track"]);
  });

  it("hands the album row's keep, unpack and remove the entry's slot id", async () => {
    render();
    h.albumProps.onSetKeep(false);
    h.albumProps.onRemove();
    h.albumProps.onUnpack();
    await vi.waitFor(() => expect(h.unpacked).toHaveBeenCalledWith(2));
    expect(h.setKeepOrder).toHaveBeenCalledWith(2, false);
    expect(h.removeSlots).toHaveBeenCalledWith([2]);
    expect(h.unpack).toHaveBeenCalledWith(2);
  });

  it("swallows a rejected write and shows no unpacked pill for it", async () => {
    h.unpack.mockRejectedValue(new Error("write failed"));
    h.setKeepOrder.mockRejectedValue(new Error("write failed"));
    h.removeSlots.mockRejectedValue(new Error("write failed"));
    render();
    h.albumProps.onUnpack();
    h.albumProps.onSetKeep(true);
    h.albumProps.onRemove();
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(h.unpacked).not.toHaveBeenCalled();
  });

  it("reorders by slot ids, the entry-wide order, when a row is dropped on another", () => {
    render();
    h.onDragEnd({ active: { id: 1 }, over: { id: 3 } });
    expect(h.reorder).toHaveBeenCalledWith(1, [2, 3, 1]);
    h.onDragEnd({ active: { id: 3 }, over: { id: 2 } });
    expect(h.reorder).toHaveBeenLastCalledWith(1, [1, 3, 2]);
  });

  it("leaves the order alone for a drop on itself, outside, or on an unknown row", () => {
    render();
    h.onDragEnd({ active: { id: 1 }, over: { id: 1 } });
    h.onDragEnd({ active: { id: 1 }, over: null });
    h.onDragEnd({ active: { id: 1 }, over: { id: 99 } });
    expect(h.reorder).not.toHaveBeenCalled();
  });

  it("plays each row of a playlist holding the same album and the same track twice at its own index", () => {
    const twiceSlots = [slotRow(1, 1, 9), slotRow(4, 4, 9)];
    const twiceEntries = [entryRow(2, 2, 5, true), entryRow(3, 3, 5, false)];
    h.expansion = expandPlaylist(twiceSlots, twiceEntries, members, { orgReady: true });
    render();
    const ids = [9, 50, 51, 50, 51, 9];
    h.rows[0].play();
    h.rows[1].play();
    h.rows[2].play();
    h.rows[2].playFrom?.(1);
    h.rows[3].play();
    expect(h.play.mock.calls.map((c) => c[1])).toEqual([0, 1, 3, 4, 5]);
    expect(h.play.mock.calls.every((c) => JSON.stringify(c[0]) === JSON.stringify(ids))).toBe(true);
    // Only the kept copy is a block.
    expect(h.play.mock.calls[0][3]).toEqual([[1, 2]]);
  });

  it("shows the empty line only for a playlist with no row at all", () => {
    h.expansion = expandPlaylist([], [], members, { orgReady: true });
    expect(render()).toContain("No tracks in this playlist yet.");
    h.expansion = expandPlaylist([], entries, members, { orgReady: false });
    expect(render()).not.toContain("No tracks in this playlist yet.");
  });
});
