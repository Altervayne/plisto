// -- Test Imports --
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

// -- Unit Imports --
import { AlbumDeleteControl } from "./AlbumDeleteControl";

const h = vi.hoisted(() => ({ org: "loading" as string, playlists: "loading" as string }));

// A static render reads a store at its initial state, so the statuses the gate follows are set here.
vi.mock("../../state/projectionStatus", () => ({
  useOrgStatus: () => h.org,
  usePlaylistsStatus: () => h.playlists,
}));
vi.mock("../../state/organize/store", () => ({ useDeleteAlbum: () => async () => {} }));
vi.mock("../../state/playlists/store", () => ({ usePlaylistsStore: { getState: () => ({ albumEntries: [] }) } }));
// Shows the tooltip label in the markup, which the real bubble only mounts on hover.
vi.mock("../common/Tooltip", () => ({
  Tooltip: (p: { label?: string; children: unknown }) => (
    <span data-tip={p.label}>{p.children as never}</span>
  ),
}));

const render = (single: boolean) =>
  renderToStaticMarkup(<AlbumDeleteControl albumId={4} onDeleted={() => {}} single={single} />);

beforeEach(() => {
  h.org = "loading";
  h.playlists = "loading";
});

describe("AlbumDeleteControl", () => {
  it("renders disabled with the tooltip while albums and playlists have not loaded", () => {
    const html = render(false);
    expect(html).toContain("disabled");
    expect(html).toContain('data-tip="Available once albums and playlists have loaded"');
  });

  it("stays disabled for an album while only the albums have loaded", () => {
    h.org = "ready";
    expect(render(false)).toContain("disabled");
  });

  it("lets a single go once the albums have loaded, as it sits in no playlist entry", () => {
    h.org = "ready";
    expect(render(true)).not.toContain("disabled");
  });

  it("is enabled, with no tooltip, once both have loaded", () => {
    h.org = "ready";
    h.playlists = "ready";
    const html = render(false);
    expect(html).not.toContain("disabled");
    expect(html).not.toContain("Available once");
  });
});
