// -- Test Imports --
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

// -- Unit Imports --
import { UnsortedView } from "./UnsortedView";

// -- Type Imports --
import type { ProjectionState } from "../../state/projectionStatus";

const h = vi.hoisted(() => ({ status: "loading" as ProjectionState }));

vi.mock("../../state/projectionStatus", () => ({ useOrgStatus: () => h.status }));
vi.mock("../../state/organize/store", () => ({
  useUnsortedTracks: () => [{ id: 1 }, { id: 2 }],
}));
vi.mock("./LibraryBrowser", () => ({
  LibraryBrowser: ({ tracks }: { tracks: unknown[] }) => <div data-browser={tracks.length} />,
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
