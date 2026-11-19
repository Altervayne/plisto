// -- Test Imports --
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

// -- Unit Imports --
import { CollectionView } from "./CollectionView";

// -- Type Imports --
import type { ProjectionState } from "../../state/projectionStatus";
import type { CollectionSegment } from "../../state/collection/store";

const h = vi.hoisted(() => ({ status: "loading" as ProjectionState }));

vi.mock("../../state/projectionStatus", () => ({ useOrgStatus: () => h.status }));
vi.mock("../../state/collection/store", () => ({
  useCloseCollectionFull: () => () => {},
  useCollectionDrawerAlbumId: () => null,
  useCollectionFullAlbumId: () => null,
  useOpenCollectionFull: () => () => {},
  useSetCollectionDrawer: () => () => {},
}));
vi.mock("../../hooks/useMountTransition", () => ({
  useMountTransition: () => ({ mounted: false, state: "enter" }),
}));
vi.mock("../organize/ProjectionPending", () => ({
  ProjectionPending: ({ state }: { state: string }) => <div data-pending={state} />,
}));
vi.mock("../albums/AlbumGrid", () => ({ AlbumGrid: () => <div data-grid="" /> }));
vi.mock("../albums/AlbumDrawer", () => ({ AlbumDrawer: () => null }));
vi.mock("../albums/AlbumFolderView", () => ({ AlbumFolderView: () => null }));
vi.mock("../tracks/AllTracksView", () => ({ AllTracksView: () => <div data-all="" /> }));
vi.mock("./browse/BrowseView", () => ({ BrowseView: () => <div data-browse="" /> }));
vi.mock("../common/Resizer/Resizer", () => ({ Resizer: () => null }));

const render = (segment: CollectionSegment) =>
  renderToStaticMarkup(
    <CollectionView segment={segment} albums={[]} singles={[]} resizer={{} as never} />,
  );

describe("CollectionView while the albums have not loaded", () => {
  it("shows the pending state for Albums, Singles and Browse", () => {
    h.status = "loading";
    for (const segment of ["albums", "singles", "browse"] as CollectionSegment[]) {
      const html = render(segment);
      expect(html).toContain('data-pending="loading"');
      expect(html).not.toContain("data-grid");
      expect(html).not.toContain("data-browse");
    }
  });

  it("leaves All tracks to its own view", () => {
    h.status = "stalled";
    expect(render("tracks")).toContain("data-all");
  });

  it("shows the wall once ready", () => {
    h.status = "ready";
    expect(render("albums")).toContain("data-grid");
  });
});
