// -- Test Imports --
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { ComponentProps, ReactNode } from "react";

// -- Unit Imports --
import { PlaylistAlbumRow } from "./PlaylistAlbumRow";
import { expandPlaylist, groupMembers } from "./playlistExpand";
import { entryRow, memberRow } from "./playlistTestRows";
import type { AlbumEntry } from "./albumEntryPlay";
import type { MenuEntry } from "../common/ContextMenu";

const h = vi.hoisted(() => ({
  items: [] as MenuEntry[],
  toggle: null as null | ((e: { stopPropagation: () => void }) => void),
}));

vi.mock("../common/IconToggle", () => ({
  IconToggle: (p: { pressed: boolean; onClick: (e: { stopPropagation: () => void }) => void }) => {
    h.toggle = p.onClick;
    return <button type="button" aria-pressed={p.pressed} />;
  },
}));
vi.mock("@dnd-kit/sortable", () => ({
  useSortable: () => ({
    attributes: {},
    listeners: {},
    setNodeRef: () => {},
    transform: null,
    transition: undefined,
    isDragging: false,
  }),
}));
vi.mock("../../state/organize/store", () => ({
  useAlbum: () => ({ id: 5, title: "Low Tide Radio", album_artist: "Ines Varga", year: 2022 }),
}));
vi.mock("../albums/useAlbumCover", () => ({ useAlbumCover: () => ({ src: null }) }));
vi.mock("../common/Tooltip/Tooltip", () => ({ Tooltip: ({ children }: { children: ReactNode }) => children }));
vi.mock("../common/ContextMenu", () => ({
  useContextMenu: () => ({ open: false, x: 0, y: 0, close: () => {}, onContextMenu: () => {} }),
  ContextMenu: (p: { items: MenuEntry[] }) => {
    h.items = p.items;
    return null;
  },
}));

const track = (id: number, no: number, title: string, missing = false) => ({
  ...memberRow(5, id, 1, no, missing ? 1 : null),
  raw_title: title,
  duration_secs: 200,
});

function entryOf(keep: boolean, members = [track(50, 1, "Static Over the Pier"), track(51, 2, "Salt on the Wire")]) {
  const expansion = expandPlaylist([], [entryRow(2, 1, 5, keep)], groupMembers(members), {
    orgReady: true,
  });
  return expansion.entries[0] as AlbumEntry;
}

const noop = () => {};
const render = (
  entry: AlbumEntry,
  o: {
    ready?: boolean;
    playerEnabled?: boolean;
    defaultOpen?: boolean;
    on?: Partial<
      Pick<
        ComponentProps<typeof PlaylistAlbumRow>,
        "onSetKeep" | "onUnpack" | "onRemove" | "onOpenAlbum"
      >
    >;
  } = {},
) =>
  renderToStaticMarkup(
    <PlaylistAlbumRow
      entry={entry}
      displayNo={2}
      ready={o.ready ?? true}
      playerEnabled={o.playerEnabled ?? true}
      defaultOpen={o.defaultOpen}
      onPlayFrom={noop}
      onPlayNext={noop}
      onAddToQueue={noop}
      onOpenAlbum={noop}
      onSetKeep={noop}
      onUnpack={noop}
      onRemove={noop}
      {...o.on}
    />,
  );

const pick = (label: string) => {
  const item = h.items.find((e) => !("separator" in e) && e.label === label);
  if (!item || "separator" in item) throw new Error(`no menu item ${label}`);
  return item;
};

const labels = () => h.items.map((e) => ("separator" in e ? "-" : e.label));

beforeEach(() => {
  h.items = [];
});

describe("PlaylistAlbumRow", () => {
  it("reads the title, artist and year from the album row, with the track count and length", () => {
    const html = render(entryOf(true));
    expect(html).toContain("Low Tide Radio");
    expect(html).toContain("Ines Varga - 2022 - 2 tracks");
    expect(html).toContain("6:40");
    expect(html).not.toContain("Static Over the Pier");
  });

  it("reads as loading until the expansion is ready, never as an empty album", () => {
    const loading = expandPlaylist([], [entryRow(2, 1, 5, true)], groupMembers([track(50, 1, "A")]), {
      orgReady: false,
    }).entries[0] as AlbumEntry;
    const html = render(loading, { ready: false });
    expect(html).toContain("Loading...");
    expect(html).not.toContain("0 tracks");
    expect(html).not.toContain("Low Tide Radio");
    expect(html).toContain('data-loading=""');
  });

  it("never unfolds while loading", () => {
    const loading = expandPlaylist([], [entryRow(2, 1, 5, true)], groupMembers([track(50, 1, "A")]), {
      orgReady: false,
    }).entries[0] as AlbumEntry;
    expect(render(loading, { ready: false, defaultOpen: true })).not.toContain('data-open=""');
  });

  it("unfolds into its members in album order inside the one wrapper", () => {
    const html = render(entryOf(true), { defaultOpen: true });
    expect(html).toContain('data-open=""');
    expect(html.indexOf("Static Over the Pier")).toBeLessThan(html.indexOf("Salt on the Wire"));
    // The panel sits inside the entry wrapper: one surface with the head row.
    expect(html.indexOf("Static Over the Pier")).toBeGreaterThan(html.indexOf("data-open"));
    expect(html.match(/class="[^"]*entry[^"]*"/g)).toHaveLength(1);
  });

  it("tags a missing member and counts it on the head", () => {
    const html = render(
      entryOf(true, [track(50, 1, "Static Over the Pier"), track(51, 2, "Salt on the Wire", true)]),
      { defaultOpen: true },
    );
    expect(html).toContain("File missing");
    expect(html).toContain("1 missing");
    expect(html).toContain('data-missing=""');
  });

  it("says all missing when no member has a file", () => {
    const html = render(entryOf(true, [track(50, 1, "A", true), track(51, 2, "B", true)]));
    expect(html).toContain("all missing");
    expect(html).toContain('data-all-missing=""');
  });

  it("shows the keep toggle pressed when kept and not when loose, always visible", () => {
    expect(render(entryOf(true))).toContain('aria-pressed="true"');
    expect(render(entryOf(false))).toContain('aria-pressed="false"');
  });
});

describe("PlaylistAlbumRow menu", () => {
  it("lists the play group, the setting, open, unpack and remove", () => {
    render(entryOf(true));
    expect(labels()).toEqual([
      "Play",
      "Play next",
      "Add to queue",
      "-",
      "Keep in the same order",
      "Open album",
      "Unpack into tracks",
      "-",
      "Remove from playlist",
    ]);
  });

  it("carries the keep state as a switch row", () => {
    render(entryOf(true));
    expect(h.items.find((e) => "label" in e && e.label === "Keep in the same order")).toMatchObject({
      checked: true,
    });
    render(entryOf(false));
    expect(h.items.find((e) => "label" in e && e.label === "Keep in the same order")).toMatchObject({
      checked: false,
    });
  });

  it("drops the play group while the player is off", () => {
    render(entryOf(true), { playerEnabled: false });
    expect(labels()[0]).toBe("Keep in the same order");
    expect(labels()).not.toContain("Play");
  });

  it("reaches Remove, Unpack, Open album and the flipped Keep through the menu", () => {
    const on = { onRemove: vi.fn(), onUnpack: vi.fn(), onOpenAlbum: vi.fn(), onSetKeep: vi.fn() };
    render(entryOf(true), { on });
    pick("Remove from playlist").onSelect();
    pick("Unpack into tracks").onSelect();
    pick("Open album").onSelect();
    pick("Keep in the same order").onSelect();
    expect(on.onRemove).toHaveBeenCalledTimes(1);
    expect(on.onUnpack).toHaveBeenCalledTimes(1);
    expect(on.onOpenAlbum).toHaveBeenCalledTimes(1);
    expect(on.onSetKeep).toHaveBeenCalledWith(false);
  });

  it("flips Keep from the toggle on the row, without reaching the row's own click", () => {
    const onSetKeep = vi.fn();
    const stop = vi.fn();
    render(entryOf(false), { on: { onSetKeep } });
    h.toggle?.({ stopPropagation: stop });
    expect(onSetKeep).toHaveBeenCalledWith(true);
    expect(stop).toHaveBeenCalled();
  });

  it("greys the play group out when every member is gone", () => {
    render(entryOf(true, [track(50, 1, "A", true)]));
    expect(h.items[0]).toMatchObject({ label: "Play", disabled: true });
  });
});
