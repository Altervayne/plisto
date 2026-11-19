// -- Test Imports --
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

// -- Unit Imports --
import { CollectionView } from "./CollectionView";

// -- Type Imports --
import type { ProjectionState } from "../../state/projectionStatus";
import type { CollectionSegment } from "../../state/collection/store";

const h = vi.hoisted(() => ({
  status: "loading" as ProjectionState,
  proposals: null as null | { albumCount: number },
  organize: true,
}));

vi.mock("../../state/projectionStatus", () => ({ useOrgStatus: () => h.status }));
vi.mock("../../state/collection/store", () => ({
  useCloseCollectionFull: () => () => {},
  useCollectionDrawerAlbumId: () => null,
  useCollectionFullAlbumId: () => null,
  useOpenCollectionFull: () => () => {},
  useRouteCollection: () => () => {},
  useSetCollectionDrawer: () => () => {},
}));
vi.mock("../../state/organize/tagProposals", () => ({ useTagProposals: () => h.proposals }));
vi.mock("../../state/player/store", () => ({ useOrganizeEnabled: () => h.organize }));
vi.mock("../organize/albumsFromTags/useLibraryTagReview", () => ({
  useLibraryTagReview: () => ({ open: () => {}, sheet: null }),
}));
vi.mock("../../hooks/useMountTransition", () => ({
  useMountTransition: () => ({ mounted: false, state: "enter" }),
}));
vi.mock("../organize/ProjectionPending", () => ({
  ProjectionPending: ({ state }: { state: string }) => <div data-pending={state} />,
}));
vi.mock("../albums/AlbumGrid", () => ({
  AlbumGrid: ({ emptyAction }: { emptyAction?: never }) => <div data-grid="">{emptyAction}</div>,
}));
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

describe("CollectionView pointer on an empty wall", () => {
  it("points at the proposals on empty Albums and Singles pages", () => {
    h.status = "ready";
    h.organize = true;
    h.proposals = { albumCount: 12 };
    for (const segment of ["albums", "singles"] as CollectionSegment[]) {
      const html = render(segment);
      expect(html).toContain("Your unsorted tracks can make 12 albums from their tags.");
      expect(html).toContain("Review albums");
    }
  });

  it("shows no pointer without proposals, off the empty wall, or in Player mode", () => {
    h.status = "ready";
    h.proposals = null;
    expect(render("albums")).not.toContain("can make");
    h.proposals = { albumCount: 12 };
    h.organize = false;
    expect(render("albums")).not.toContain("can make");
    h.organize = true;
    const filled = renderToStaticMarkup(
      <CollectionView
        segment="albums"
        albums={[{ id: 1 } as never]}
        singles={[]}
        resizer={{} as never}
      />,
    );
    expect(filled).not.toContain("can make");
  });
});
