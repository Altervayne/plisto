// -- Test Imports --
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

// -- Unit Imports --
import { UnsortedView } from "./UnsortedView";

// -- Type Imports --
import type { ProjectionState } from "../../state/projectionStatus";

const h = vi.hoisted(() => ({
  status: "loading" as ProjectionState,
  entry: null as null | { summary: unknown; dismiss: () => void },
  folder: null as string | null,
}));

vi.mock("../../state/projectionStatus", () => ({ useOrgStatus: () => h.status }));
vi.mock("../../state/organize/store", () => ({
  useUnsortedTracks: () => [{ id: 1 }, { id: 2 }],
}));
vi.mock("../../state/organize/tagProposals", () => ({ useTagEntry: () => h.entry }));
vi.mock("./LibraryBrowser", () => ({
  LibraryBrowser: ({
    tracks,
    banner,
  }: {
    tracks: unknown[];
    banner?: (scope: { id: string; tracks: never[]; name: string | null }) => unknown;
  }) => (
    <div data-browser={tracks.length}>
      {banner?.({ id: "", tracks: [], name: h.folder }) as never}
    </div>
  ),
}));
vi.mock("../organize/ProjectionPending", () => ({
  ProjectionPending: ({ state }: { state: string }) => <div data-pending={state} />,
}));
vi.mock("../organize/albumsFromTags/AlbumsFromTagsButton", () => ({ AlbumsFromTagsButton: () => null }));
vi.mock("../organize/albumsFromTags/AlbumsFromTagsSheet", () => ({ AlbumsFromTagsSheet: () => null }));

const render = () => renderToStaticMarkup(<UnsortedView onShowAlbums={() => {}} />);

describe("UnsortedView while the albums have not loaded", () => {
  it("shows the pending state and lists no track while loading", () => {
    h.status = "loading";
    const html = render();
    expect(html).toContain('data-pending="loading"');
    expect(html).not.toContain("data-browser");
  });

  it("shows the pending state and no browser once stalled", () => {
    h.status = "stalled";
    const html = render();
    expect(html).toContain('data-pending="stalled"');
    expect(html).not.toContain("data-browser");
  });

  it("lists the loose tracks once ready", () => {
    h.status = "ready";
    const html = render();
    expect(html).toContain('data-browser="2"');
    expect(html).not.toContain("data-pending");
  });
});

describe("UnsortedView library-wide band", () => {
  const summary = { keys: ["a"], albumCount: 1284, trackCount: 18402, looseCount: 21730 };

  it("shows the offer with its counts when proposals are not dismissed", () => {
    h.status = "ready";
    h.entry = { summary, dismiss: () => {} };
    h.folder = null;
    const html = render();
    expect(html).toContain("1,284 albums can be built from your tags");
    expect(html).toContain("18,402 of your 21,730 unsorted tracks");
    expect(html).toContain("Review albums");
    expect(html).toContain("Not now");
    expect(html).not.toContain("Whole library");
  });

  it("labels the band as the whole library when a folder is drilled into", () => {
    h.status = "ready";
    h.entry = { summary, dismiss: () => {} };
    h.folder = "Bandcamp rips";
    expect(render()).toContain("Whole library");
  });

  it("shows no band without an entry", () => {
    h.status = "ready";
    h.entry = null;
    const html = render();
    expect(html).toContain("data-browser");
    expect(html).not.toContain("can be built");
  });
});
