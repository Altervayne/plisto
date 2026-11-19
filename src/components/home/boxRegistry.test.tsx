// -- Test Imports --
import { describe, expect, it, vi } from "vitest";
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

// -- Unit Imports --
import { BOX_COMPONENTS } from "./boxRegistry";

// -- Type Imports --
import type { ProjectionState } from "../../state/projectionStatus";

const h = vi.hoisted(() => ({ status: "loading" as ProjectionState, held: false }));

vi.mock("../../hooks/useDelayedFlag", () => ({ useDelayedFlag: (on: boolean) => on && h.held }));
vi.mock("./StatBox", () => ({
  StatBox: ({ count }: { count: number | null }) => <i data-stat={count == null ? "none" : count} />,
}));
vi.mock("./PreviewBox", () => ({
  PreviewBox: ({ rows, invite }: { rows: unknown[]; invite: string }) => (
    <i data-rows={rows.length} data-invite={invite} />
  ),
}));
vi.mock("./SuggestionBox", () => ({ SuggestionBox: () => null }));
vi.mock("../../state/projectionStatus", () => ({ useOrgStatus: () => h.status }));
vi.mock("../../state/covers/store", () => ({ useNeedsCoverCount: () => 0 }));
vi.mock("../../state/organize/store", () => ({
  useUnsortedTracks: () => [{ id: 1 }, { id: 2 }, { id: 3 }],
  useAlbumIndex: () => new Map(),
  useAlbumTracks: () => [],
  useMembership: () => [],
}));
vi.mock("../../state/player/playHistory", () => ({
  useMostPlayed: () => [],
  useRecentlyPlayed: () => [],
}));
vi.mock("../../state/player/store", () => ({
  usePlayerActions: () => ({ play: () => {} }),
  usePlayerEnabled: () => false,
}));
vi.mock("../../state/shell/store", () => ({ useSetHistoryLens: () => () => {} }));
vi.mock("../../state/store", () => ({
  useSetLibraryFacets: () => () => {},
  useSetLibraryMissingMetadata: () => () => {},
  useTracks: () => [{ id: 1, raw_title: null, raw_artist: null, raw_album: null }],
}));

const render = (type: "unsortedStat" | "unsortedPreview" | "missingMetadata") =>
  renderToStaticMarkup(createElement(BOX_COMPONENTS[type], { onNavigate: () => {} }));

describe("Home boxes while the albums have not loaded", () => {
  it("gives the stat boxes no count", () => {
    h.status = "loading";
    expect(render("unsortedStat")).toContain('data-stat="none"');
    expect(render("missingMetadata")).toContain('data-stat="none"');
  });

  it("lists no loose track and claims no all-clear in the preview", () => {
    h.status = "stalled";
    const html = render("unsortedPreview");
    expect(html).toContain('data-rows="0"');
    expect(html).toContain('data-invite=""');
  });

  it("says the albums are still loading once the wait is long enough to notice", () => {
    h.status = "loading";
    h.held = true;
    expect(render("unsortedPreview")).toContain('data-invite="Albums and playlists are still loading"');
    h.held = false;
  });

  it("counts and lists once ready", () => {
    h.status = "ready";
    expect(render("unsortedStat")).toContain('data-stat="3"');
    expect(render("unsortedPreview")).toContain('data-rows="3"');
  });
});
