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
  buttons: [] as Array<{ label: string; disabled?: boolean; onClick?: () => void }>,
  rows: [] as Array<{ state: string; dim?: boolean }>,
  actions: { stop: vi.fn(), clearParked: vi.fn(), jump: vi.fn(), reorderQueue: vi.fn(), removeFromQueue: vi.fn() },
  createPlaylist: vi.fn(async () => 5),
  addTracks: vi.fn(async () => {}),
  cleared: vi.fn(),
}));

vi.mock("../../state/player/store", () => ({
  usePlayerActions: () => h.actions,
  usePlayerQueue: () => h.queue,
  usePlayerQueueIndex: () => h.queueIndex,
  usePlayerQueueMeta: () => ({}),
  useSeatedStream: () => h.stream,
  useHasParked: () => h.hasParked,
}));
vi.mock("../../state/player/queueToast", () => ({ cleared: h.cleared }));
vi.mock("../../state/playlists/store", () => ({
  useCreatePlaylist: () => h.createPlaylist,
  useAddTracksToPlaylist: () => h.addTracks,
}));
vi.mock("../common/ScrollArea/ScrollArea", () => ({
  ScrollArea: ({ children }: { children: ReactNode }) => <div>{children}</div>,
}));
vi.mock("../common/Tooltip", () => ({ Tooltip: ({ children }: { children: ReactNode }) => children }));
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
vi.mock("./QueueStreamCard", () => ({ QueueStreamCard: () => <div data-card="" /> }));

const render = () => {
  h.buttons = [];
  h.rows = [];
  return renderToStaticMarkup(<QueueList />);
};
const button = (label: string) => h.buttons.find((b) => b.label === label);

beforeEach(() => {
  vi.clearAllMocks();
  h.stream = streamNowFixture();
  h.queue = [11, 12, 13];
  h.queueIndex = 1;
  h.hasParked = true;
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
    expect(h.actions.clearParked).not.toHaveBeenCalled();
  });
});
