// -- Test Imports --
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

// -- Unit Imports --
import { AllTracksView } from "./AllTracksView";

// -- Type Imports --
import type { ProjectionState } from "../../state/projectionStatus";

const h = vi.hoisted(() => ({ status: "loading" as ProjectionState, missing: true }));

vi.mock("../../state/projectionStatus", () => ({ useOrgStatus: () => h.status }));
vi.mock("../../state/organize/store", () => ({ useAlbumIndex: () => new Map() }));
vi.mock("../../state/store", () => {
  const noop = () => () => {};
  return {
    useClearLibraryReveal: noop,
    useLibraryFacets: () => [],
    useLibraryGone: () => false,
    useLibraryGroupBy: () => "none",
    useLibraryMissingMetadata: () => h.missing,
    useLibraryRevealId: () => null,
    useLibrarySearch: () => "",
    useLibrarySort: () => null,
    useLibraryView: () => "table",
    useSetLibraryFacets: noop,
    useSetLibraryGone: noop,
    useSetLibraryGroupBy: noop,
    useSetLibraryMissingMetadata: noop,
    useSetLibrarySearch: noop,
    useSetLibrarySort: noop,
    useSetLibraryView: noop,
    useTracks: () => [{ id: 1 }],
  };
});
vi.mock("./TrackGrid", () => ({ TrackGrid: () => <div data-grid="" /> }));
vi.mock("./TrackDetail", () => ({ TrackDetail: () => null }));
vi.mock("./FacetFilter", () => ({ FacetFilter: () => <div data-facet="" /> }));
vi.mock("../common/Resizer/Resizer", () => ({ Resizer: () => null }));
vi.mock("../common/Resizer/useDrawerResize", () => ({
  useDrawerResize: () => ({ width: 300, containerRef: { current: null }, resizer: {} }),
}));
vi.mock("../organize/ProjectionPending", () => ({
  ProjectionPending: ({ state }: { state: string }) => <div data-pending={state} />,
}));

describe("AllTracksView missing-metadata narrowing", () => {
  it("keeps the header and the filter and holds the list while the albums load", () => {
    h.status = "loading";
    h.missing = true;
    const html = renderToStaticMarkup(<AllTracksView />);
    expect(html).toContain("<h1");
    expect(html).toContain("data-facet");
    expect(html).toContain('data-pending="loading"');
    expect(html).not.toContain("data-grid");
  });

  it("lists the tracks when the narrowing is off", () => {
    h.status = "loading";
    h.missing = false;
    const html = renderToStaticMarkup(<AllTracksView />);
    expect(html).toContain("data-grid");
    expect(html).not.toContain("data-pending");
  });

  it("lists the tracks once ready", () => {
    h.status = "ready";
    h.missing = true;
    expect(renderToStaticMarkup(<AllTracksView />)).toContain("data-grid");
  });
});
