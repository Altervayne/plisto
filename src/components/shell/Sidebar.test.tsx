// -- Test Imports --
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

// -- Unit Imports --
import { Sidebar } from "./Sidebar";

const h = vi.hoisted(() => ({
  appMode: "both",
  entry: null as null | { summary: { albumCount: number } },
  review: null as null | (() => void),
  open: vi.fn(),
  gone: null as null | { summary: { total: number }; dismiss: () => void },
  goneReview: null as null | (() => void),
  goneDismiss: null as null | (() => void),
  openGone: vi.fn(),
}));

vi.mock("./NavItem", () => ({
  NavItem: ({ label, count }: { label: string; count?: number }) => (
    <i data-nav={label} data-count={count == null ? "none" : count} />
  ),
}));
vi.mock("./SearchPill", () => ({ SearchPill: () => null }));
vi.mock("../common/ScrollArea/ScrollArea", () => ({
  ScrollArea: ({ children }: { children: unknown }) => <div>{children as never}</div>,
}));
vi.mock("../player/MiniPlayer", () => ({ MiniPlayer: () => null }));
vi.mock("../player/AppModeSwitch", () => ({ AppModeSwitch: () => null }));
vi.mock("../plugins/sidebar/PluginSidebarZone", () => ({ PluginSidebarZone: () => null }));
vi.mock("../../state/player/store", () => ({ useAppMode: () => h.appMode }));
vi.mock("../../state/shell/store", () => ({ usePluginRoute: () => null, useOpenGone: () => h.openGone }));
vi.mock("../../state/gone/goneEntry", () => ({ useGoneEntry: () => h.gone }));
vi.mock("../gone/GoneRailCard", () => ({
  GoneRailCard: ({ total, onReview, onDismiss }: { total: number; onReview: () => void; onDismiss: () => void }) => {
    h.goneReview = onReview;
    h.goneDismiss = onDismiss;
    return <i data-gone-card={total} />;
  },
}));
vi.mock("../../state/collection/store", () => ({ useRouteCollection: () => () => {} }));
vi.mock("../../state/organize/tagProposals", () => ({ useTagEntry: () => h.entry }));
vi.mock("../organize/albumsFromTags/useLibraryTagReview", () => ({
  useLibraryTagReview: () => ({ open: h.open, sheet: null }),
}));
vi.mock("../organize/albumsFromTags/TagAlbumsRailCard", () => ({
  TagAlbumsRailCard: ({ albumCount, onReview }: { albumCount: number; onReview: () => void }) => {
    h.review = onReview;
    return <i data-rail-card={albumCount} />;
  },
}));

const render = (counts: { unsortedCount?: number; playlistsCount?: number } = {}, collapsed = false) =>
  renderToStaticMarkup(
    <Sidebar
      mode="home"
      onModeChange={() => {}}
      onOpenPlugin={() => {}}
      filesCount={10}
      coversCount={0}
      collapsed={collapsed}
      {...counts}
    />,
  );

describe("Sidebar rail notice", () => {
  beforeEach(() => {
    h.appMode = "both";
    h.entry = null;
    h.review = null;
    h.open.mockClear();
    h.gone = null;
    h.goneReview = null;
    h.goneDismiss = null;
    h.openGone.mockClear();
  });

  it("shows the albums card in the Files group when there is an entry", () => {
    h.entry = { summary: { albumCount: 12 } };
    expect(render()).toContain('data-rail-card="12"');
  });

  it("shows nothing without an entry", () => {
    expect(render()).not.toContain("data-rail-card");
  });

  it("shows nothing in Player mode, where the Files group is gone", () => {
    h.entry = { summary: { albumCount: 12 } };
    h.appMode = "player";
    expect(render()).not.toContain("data-rail-card");
  });

  it("shows nothing while the rail is collapsed", () => {
    h.entry = { summary: { albumCount: 12 } };
    expect(render({}, true)).not.toContain("data-rail-card");
  });

  it("opens the library review when the card is clicked", () => {
    h.entry = { summary: { albumCount: 12 } };
    render();
    h.review?.();
    expect(h.open).toHaveBeenCalledTimes(1);
  });

  it("shows the gone card alone when both notices qualify", () => {
    h.entry = { summary: { albumCount: 12 } };
    h.gone = { summary: { total: 80 }, dismiss: () => {} };
    const html = render();
    expect(html).toContain('data-gone-card="80"');
    expect(html).not.toContain("data-rail-card");
  });

  it("falls back to the albums card when the gone entry is absent (below threshold, dismissed, not ready, offline only)", () => {
    h.entry = { summary: { albumCount: 12 } };
    const html = render();
    expect(html).toContain('data-rail-card="12"');
    expect(html).not.toContain("data-gone-card");
  });

  it("shows the gone card without an albums entry", () => {
    h.gone = { summary: { total: 80 }, dismiss: () => {} };
    expect(render()).toContain('data-gone-card="80"');
  });

  it("hides the gone card while collapsed and in Player mode", () => {
    h.gone = { summary: { total: 80 }, dismiss: () => {} };
    expect(render({}, true)).not.toContain("data-gone-card");
    h.appMode = "player";
    expect(render()).not.toContain("data-gone-card");
  });

  it("opens the gone sheet at library scope and passes the dismissal through", () => {
    const dismiss = vi.fn();
    h.gone = { summary: { total: 80 }, dismiss };
    render();
    h.goneReview?.();
    expect(h.openGone).toHaveBeenCalledWith();
    h.goneDismiss?.();
    expect(dismiss).toHaveBeenCalledTimes(1);
  });
});

describe("Sidebar counts", () => {
  it("omits the Unsorted and Playlists counts when not given", () => {
    const html = render({});
    expect(html).toContain('data-nav="Unsorted" data-count="none"');
    expect(html).toContain('data-nav="Playlists" data-count="none"');
  });

  it("keeps a zero count, which is a loaded value", () => {
    const html = render({ unsortedCount: 0, playlistsCount: 3 });
    expect(html).toContain('data-nav="Unsorted" data-count="0"');
    expect(html).toContain('data-nav="Playlists" data-count="3"');
  });
});
