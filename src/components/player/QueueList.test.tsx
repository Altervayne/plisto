// -- Test Imports --
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";
import type { ReactNode } from "react";

// -- Unit Imports --
import { QueueList } from "./QueueList";
import { streamNowFixture } from "../../state/player/streamFixtures";

// -- Type Imports --
import type { StreamNow } from "../../types";

const h = vi.hoisted(() => ({
  stream: null as StreamNow | null,
  queue: [11, 12, 13] as number[],
  queueIndex: 1,
  hasParked: true,
  blocks: [] as Array<[number, number]>,
  albums: new Map<number, { id: number; title: string | null }>(),
  buttons: [] as Array<{ label: string; disabled?: boolean; onClick?: () => void }>,
  rows: [] as Array<{ state: string; dim?: boolean }>,
  bands: [] as Array<{
    albumId: number | null;
    title: string | null;
    length: number;
    place: number | null;
    now: boolean;
    dim: boolean;
  }>,
  actions: { stop: vi.fn(), clearParked: vi.fn(), jump: vi.fn(), reorderQueue: vi.fn(), removeFromQueue: vi.fn() },
  createPlaylist: vi.fn(async () => 5),
  addTracks: vi.fn(async () => {}),
  cleared: vi.fn(),
  clearSaved: vi.fn(),
  saveBlocked: false,
}));

vi.mock("../../state/player/store", () => ({
  usePlayerActions: () => h.actions,
  usePlayerQueue: () => h.queue,
  usePlayerQueueBlocks: () => h.blocks,
  usePlayerQueueIndex: () => h.queueIndex,
  usePlayerQueueMeta: () => ({}),
  useSeatedStream: () => h.stream,
  useHasParked: () => h.hasParked,
}));
vi.mock("../../state/organize/store", () => ({ useAlbumIndex: () => h.albums }));
vi.mock("../../state/player/useResumeWriter", () => ({ clearSavedResume: h.clearSaved }));
vi.mock("../../state/player/queueToast", () => ({ cleared: h.cleared }));
vi.mock("../../state/playlists/store", () => ({
  useCreatePlaylist: () => h.createPlaylist,
  useAddTracksToPlaylist: () => h.addTracks,
}));
vi.mock("../organize/useWriteGate", () => ({
  useWriteGate: () => ({ blocked: h.saveBlocked, tip: h.saveBlocked ? "wait" : undefined }),
}));
vi.mock("../common/ScrollArea/ScrollArea", () => ({
  ScrollArea: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));
// Exposes the label in the markup, which the real bubble only mounts on hover.
vi.mock("../common/Tooltip", () => ({
  Tooltip: ({ label, children }: { label?: string; children: ReactNode }) => (
    <span data-tip={label}>{children}</span>
  ),
}));
vi.mock("../common/QuietButton", () => ({
  QuietButton: (p: { children: string; disabled?: boolean; onClick?: () => void }) => {
    h.buttons.push({ label: p.children, disabled: p.disabled, onClick: p.onClick });
    return <button type="button">{p.children}</button>;
  },
}));
vi.mock("./QueueRow", () => ({
  QueueRow: (p: { state: string; dim?: boolean }) => {
    h.rows.push({ state: p.state, dim: p.dim });
    return <i data-row={p.state} />;
  },
}));
vi.mock("./QueueBand", () => ({
  QueueBand: (p: {
    albumId: number | null;
    title: string | null;
    length: number;
    place: number | null;
    now: boolean;
    dim: boolean;
    children: ReactNode;
  }) => {
    h.bands.push({
      albumId: p.albumId,
      title: p.title,
      length: p.length,
      place: p.place,
      now: p.now,
      dim: p.dim,
    });
    return <section data-band="">{p.children}</section>;
  },
}));
vi.mock("./QueueStreamCard", () => ({ QueueStreamCard: () => <div data-card="" /> }));

const render = () => {
  h.buttons = [];
  h.rows = [];
  h.bands = [];
  return renderToStaticMarkup(<QueueList />);
};
const button = (label: string) => h.buttons.find((b) => b.label === label);

beforeEach(() => {
  vi.clearAllMocks();
  h.stream = streamNowFixture();
  h.queue = [11, 12, 13];
  h.queueIndex = 1;
  h.hasParked = true;
  h.blocks = [];
  h.albums = new Map();
  h.saveBlocked = false;
});

describe("QueueList with a stream seated", () => {
  it("shows the stream card above the parked header naming the plugin", () => {
    const html = render();
    expect(html.indexOf("data-card")).toBeGreaterThan(-1);
    expect(html.indexOf("data-card")).toBeLessThan(html.indexOf("Your queue, paused while Night Radio plays"));
    expect(html).not.toContain("Up next");
  });

  it("marks no row as playing and dims every row", () => {
    const html = render();
    expect(h.rows.map((r) => r.state)).toEqual(["played", "parked", "next"]);
    expect(h.rows.every((r) => r.dim)).toBe(true);
    expect(html).not.toContain('data-row="now"');
  });

  it("reads the cursor row as next when nothing is parked under the stream", () => {
    h.hasParked = false;
    render();
    expect(h.rows.map((r) => r.state)).toEqual(["played", "next", "next"]);
  });

  it("passes the empty name of a connecting placeholder on, for the plain toast line", () => {
    h.stream = streamNowFixture({ plugin_name: "" });
    render();
    button("Clear queue")?.onClick?.();
    expect(h.cleared).toHaveBeenCalledWith("");
  });

  it("clears the parked queue, never stops, and says the stream plays on", () => {
    render();
    button("Clear queue")?.onClick?.();
    expect(h.actions.clearParked).toHaveBeenCalledTimes(1);
    expect(h.actions.stop).not.toHaveBeenCalled();
    expect(h.cleared).toHaveBeenCalledWith("Night Radio");
  });

  it("holds no icon toggles in the parked header: sequencing and the visualizer live in the hero", () => {
    const html = render();
    expect(html).not.toContain("aria-pressed");
    expect(html).not.toContain("<svg");
  });

  it("keeps Clear queue out of the footer, so only the header one exists", () => {
    render();
    expect(h.buttons.filter((b) => b.label === "Clear queue")).toHaveLength(1);
  });

  it("saves the parked queue as a playlist", async () => {
    h.queue = [11, -4, 13];
    render();
    button("Save as playlist")?.onClick?.();
    await vi.waitFor(() => expect(h.addTracks).toHaveBeenCalledWith(5, [11, 13]));
    expect(h.createPlaylist).toHaveBeenCalledTimes(1);
  });

  it("disables Save while playlists have not loaded", () => {
    h.saveBlocked = true;
    render();
    expect(button("Save as playlist")?.disabled).toBe(true);
  });

  it("carries the gate's tip on the blocked Save, in place of the parked hint", () => {
    h.saveBlocked = true;
    const html = render();
    expect(html).toContain('data-tip="wait"');
    expect(html).not.toContain("Saves the parked queue");
  });

  it("shows the parked hint on Save once playlists have loaded", () => {
    const html = render();
    expect(html).not.toContain('data-tip="wait"');
    expect(html).toContain('data-tip="Saves the parked queue"');
  });

  it("shows the empty line and disables Save and Clear with nothing parked", () => {
    h.queue = [];
    h.queueIndex = 0;
    const html = render();
    expect(html).toContain("Nothing queued up next.");
    expect(button("Save as playlist")?.disabled).toBe(true);
    expect(button("Clear queue")?.disabled).toBe(true);
  });
});

describe("QueueList with no stream", () => {
  beforeEach(() => {
    h.stream = null;
  });

  it("keeps the normal form: up next header, the current row playing, the footer stopping", () => {
    const html = render();
    expect(html).toContain("Up next");
    expect(html).not.toContain("aria-pressed");
    expect(html).not.toContain("<svg");
    expect(html).not.toContain("data-card");
    expect(h.rows.map((r) => r.state)).toEqual(["played", "now", "next"]);
    expect(h.rows.some((r) => r.dim)).toBe(false);
    button("Clear queue")?.onClick?.();
    expect(h.actions.stop).toHaveBeenCalledTimes(1);
    expect(h.clearSaved).toHaveBeenCalledTimes(1);
    expect(h.actions.clearParked).not.toHaveBeenCalled();
  });

  it("with a stream seated, Clear queue leaves the saved blob to the parked-cleared write", () => {
    h.stream = streamNowFixture();
    render();
    button("Clear queue")?.onClick?.();
    expect(h.clearSaved).not.toHaveBeenCalled();
  });
});

describe("QueueList with a kept block", () => {
  beforeEach(() => {
    h.stream = null;
    h.queue = [10, 11, 12, 13, 14];
    h.blocks = [[1, 3]];
    h.queueIndex = 2;
    h.albums = new Map([[11, { id: 7, title: "Low Tide Radio" }]]);
  });

  it("draws the block's rows under one band naming the album, with the cursor's place", () => {
    const html = render();
    expect(h.bands).toEqual([
      { albumId: 7, title: "Low Tide Radio", length: 3, place: 2, now: true, dim: false },
    ]);
    // Every row stays in the list: the block's three sit inside the band, the others outside.
    expect(h.rows).toHaveLength(5);
    const band = html.slice(html.indexOf("<section"), html.indexOf("</section>"));
    expect(band.match(/data-row=/g)).toHaveLength(3);
  });

  it("counts the tracks while the cursor is outside the block", () => {
    h.queueIndex = 0;
    render();
    expect(h.bands[0]).toMatchObject({ place: null, now: false });
  });

  it("gives a run of one row no band", () => {
    h.blocks = [[1, 1]];
    render();
    expect(h.bands).toEqual([]);
    expect(h.rows).toHaveLength(5);
  });

  it("drops the band's name when the album cannot be resolved", () => {
    h.albums = new Map();
    render();
    expect(h.bands[0]).toMatchObject({ albumId: null, title: null });
  });

  it("dims the band under a stream and marks it live only with a track parked", () => {
    h.stream = streamNowFixture();
    render();
    expect(h.bands[0]).toMatchObject({ dim: true, now: true, place: 2 });
    h.hasParked = false;
    render();
    expect(h.bands[0]).toMatchObject({ dim: true, now: false, place: null });
  });
});
