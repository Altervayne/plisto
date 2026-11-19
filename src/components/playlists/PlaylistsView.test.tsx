// -- Test Imports --
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

// -- Unit Imports --
import { PlaylistsView } from "./PlaylistsView";
import { PlaylistView } from "./PlaylistView";

// -- Type Imports --
import type { ProjectionState } from "../../state/projectionStatus";

const h = vi.hoisted(() => ({ status: "loading" as ProjectionState }));

vi.mock("../../state/projectionStatus", () => ({ usePlaylistsStatus: () => h.status }));
vi.mock("../../state/playlists/store", () => ({
  useCreatePlaylist: () => async () => 1,
  usePlaylists: () => [],
  usePlaylistTracks: () => [],
}));
vi.mock("../../state/store", () => ({ useTrack: () => null }));
vi.mock("../common/Resizer/useDrawerResize", () => ({
  useDrawerResize: () => ({ width: 300, containerRef: { current: null }, resizer: {} }),
}));
vi.mock("../organize/ProjectionPending", () => ({
  ProjectionPending: ({ state }: { state: string }) => <div data-pending={state} />,
}));
vi.mock("../files/Breadcrumb", () => ({ Breadcrumb: () => <nav data-crumbs="" /> }));
vi.mock("../common/ScrollArea/ScrollArea", () => ({
  ScrollArea: ({ children }: { children: unknown }) => <div data-scroll="">{children as never}</div>,
}));
vi.mock("./PlaylistRow", () => ({ PlaylistRow: () => null }));
vi.mock("./PlaylistHeader", () => ({ PlaylistHeader: () => null }));
vi.mock("./PlaylistTrackList", () => ({ PlaylistTrackList: () => <div data-list="" /> }));
vi.mock("../tracks/TrackDetail", () => ({ TrackDetail: () => null }));

describe("PlaylistsView", () => {
  it("shows the pending state, not the empty-playlists state, while loading", () => {
    h.status = "loading";
    const html = renderToStaticMarkup(<PlaylistsView onOpen={() => {}} />);
    expect(html).toContain('data-pending="loading"');
    expect(html).not.toContain("New playlist");
  });

  it("shows the empty state once ready with none", () => {
    h.status = "ready";
    expect(renderToStaticMarkup(<PlaylistsView onOpen={() => {}} />)).toContain("New playlist");
  });
});

describe("PlaylistView", () => {
  const render = () =>
    renderToStaticMarkup(<PlaylistView playlistId={1} onBack={() => {}} onOpenAlbum={() => {}} />);

  it("keeps its breadcrumb and puts the pending state where the list goes", () => {
    h.status = "stalled";
    const html = render();
    expect(html).toContain("data-crumbs");
    expect(html).toContain('data-pending="stalled"');
    expect(html).not.toContain("data-list");
  });

  it("lists the slots once ready", () => {
    h.status = "ready";
    const html = render();
    expect(html).toContain("data-list");
    expect(html).not.toContain("data-pending");
  });
});
