// -- Test Imports --
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

// -- Unit Imports --
import { GenreSettingRow } from "./GenreSettingRow";

// -- IPC Imports --
import { notReadyError } from "../../lib/ipc";

const h = vi.hoisted(() => ({
  status: "loading" as string,
  mode: "idle" as string,
  setters: [] as ReturnType<typeof vi.fn>[],
  rename: vi.fn(),
  merge: vi.fn(),
  remove: vi.fn(),
  confirm: null as null | (() => void),
}));

// Forces the row's mode and records its setters, so a confirm can be shown and driven.
vi.mock("react", async (orig) => ({
  ...(await orig<typeof import("react")>()),
  useState: (init: unknown) => {
    const setter = vi.fn();
    h.setters.push(setter);
    if (init === "idle") return [h.mode, setter];
    return [init, setter];
  },
}));
vi.mock("../../state/projectionStatus", () => ({
  useOrgStatus: () => h.status,
  usePlaylistsStatus: () => h.status,
}));
vi.mock("../../state/organize/store", () => ({
  useRenameGenre: () => h.rename,
  useMergeGenres: () => h.merge,
  useDeleteGenre: () => h.remove,
  useGenreRemovalImpact: () => async () => 3,
}));
// Shows the tooltip label in the markup, which the real bubble only mounts on hover.
vi.mock("../common/Tooltip", () => ({
  Tooltip: (p: { label?: string; children: unknown }) => (
    <span data-tip={p.label}>{p.children as never}</span>
  ),
}));
vi.mock("../common/QuietButton", () => ({
  QuietButton: (p: { children: string; disabled?: boolean; onClick?: () => void }) => {
    if (p.children === "Remove") h.confirm = p.onClick ?? null;
    return (
      <button type="button" disabled={p.disabled}>
        {p.children}
      </button>
    );
  },
}));

const TIP = "Available once albums and playlists have loaded";
const genre = { id: 1, name: "Rock", track_count: 4 } as never;
const other = { id: 2, name: "Jazz", track_count: 1 } as never;

const render = () => renderToStaticMarkup(<GenreSettingRow genre={genre} genres={[genre, other]} />);
const modeSetterCalls = () => h.setters.flatMap((s) => s.mock.calls.map(([v]) => v));

beforeEach(() => {
  vi.clearAllMocks();
  h.status = "loading";
  h.mode = "idle";
  h.setters = [];
  h.confirm = null;
  h.rename.mockResolvedValue(undefined);
  h.merge.mockResolvedValue(undefined);
  h.remove.mockResolvedValue(undefined);
});

describe("GenreSettingRow while albums load", () => {
  it("disables the name, merge and delete with the tooltip, and keeps the row showing", () => {
    const html = render();
    expect(html).toContain("Rock");
    expect(html.match(/disabled=""/g)).toHaveLength(3);
    expect(html.match(new RegExp(`data-tip="${TIP}"`, "g"))).toHaveLength(3);
  });

  it("enables them once the albums have loaded", () => {
    h.status = "ready";
    const html = render();
    expect(html).not.toContain("disabled");
    expect(html).not.toContain("data-tip=");
  });
});

describe("GenreSettingRow confirms", () => {
  beforeEach(() => {
    h.mode = "delete";
  });

  it("stays open and writes nothing while the albums have not loaded", async () => {
    render();
    expect(h.confirm).not.toBeNull();
    await h.confirm?.();
    expect(h.remove).not.toHaveBeenCalled();
    expect(modeSetterCalls()).not.toContain("idle");
  });

  it("absorbs a refusal that races the load, with no unhandled rejection", async () => {
    h.status = "ready";
    h.remove.mockRejectedValue(notReadyError());
    render();
    await expect(Promise.resolve(h.confirm?.())).resolves.toBeUndefined();
    expect(h.remove).toHaveBeenCalledWith(1);
  });
});
