// -- Test Imports --
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

// -- Unit Imports --
import { AlbumsFromTagsButton } from "./AlbumsFromTagsButton";

// -- Type Imports --
import type { ProjectionState } from "../../../state/projectionStatus";

const h = vi.hoisted(() => ({ status: "loading" as ProjectionState }));

vi.mock("../../../state/projectionStatus", () => ({ useOrgStatus: () => h.status }));
vi.mock("../../../state/organize/store", () => ({
  useOrganizeStore: (select: (s: { org: { albums: never[]; membership: never[] } }) => unknown) =>
    select({ org: { albums: [], membership: [] } }),
}));
vi.mock("../../../state/organize/groupByAlbumTags", () => ({
  groupByAlbumTags: () => ({ proposals: [{}, {}] }),
}));

const render = (folderScoped = false) =>
  renderToStaticMarkup(
    <AlbumsFromTagsButton tracks={[]} folderScoped={folderScoped} onOpen={() => {}} />,
  );

describe("AlbumsFromTagsButton", () => {
  it("is hidden while the albums have not loaded", () => {
    h.status = "loading";
    expect(render()).toBe("");
    h.status = "stalled";
    expect(render()).toBe("");
  });

  it("shows its entry once ready", () => {
    h.status = "ready";
    expect(render()).toContain("2");
  });

  it("names its unit only when scoped to a folder", () => {
    h.status = "ready";
    expect(render(false)).not.toContain("in this folder");
    expect(render(true)).toContain("in this folder");
  });
});
