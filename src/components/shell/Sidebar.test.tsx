// -- Test Imports --
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

// -- Unit Imports --
import { Sidebar } from "./Sidebar";

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
vi.mock("../../state/player/store", () => ({ useAppMode: () => "both" }));
vi.mock("../../state/shell/store", () => ({ usePluginRoute: () => null }));

const render = (counts: { unsortedCount?: number; playlistsCount?: number }) =>
  renderToStaticMarkup(
    <Sidebar
      mode="home"
      onModeChange={() => {}}
      onOpenPlugin={() => {}}
      filesCount={10}
      coversCount={0}
      {...counts}
    />,
  );

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
