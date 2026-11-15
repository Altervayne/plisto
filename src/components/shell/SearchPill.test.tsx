// -- Test Imports --
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

// -- Unit Imports --
import { SearchPill } from "./SearchPill";
import { Sidebar } from "./Sidebar";

vi.mock("../player/MiniPlayer", () => ({ MiniPlayer: () => null }));
vi.mock("../player/AppModeSwitch", () => ({ AppModeSwitch: () => null }));
vi.mock("../plugins/sidebar/PluginSidebarZone", () => ({ PluginSidebarZone: () => null }));
vi.mock("../common/ScrollArea/ScrollArea", () => ({
  ScrollArea: ({ children }: { children: unknown }) => <div data-scroll="">{children as never}</div>,
}));
vi.mock("../../state/player/store", () => ({ useAppMode: () => "both" }));
vi.mock("../../state/shell/store", () => ({ usePluginRoute: () => null }));

const pill = (open: boolean) => renderToStaticMarkup(<SearchPill open={open} onOpen={() => {}} />);

const rail = (extra: Partial<Parameters<typeof Sidebar>[0]> = {}) =>
  renderToStaticMarkup(
    <Sidebar
      mode="home"
      onModeChange={() => {}}
      onOpenPlugin={() => {}}
      filesCount={1}
      unsortedCount={0}
      playlistsCount={0}
      coversCount={0}
      {...extra}
    />,
  );
const search = { open: false, onOpen: () => {}, pillRef: { current: null } };

describe("SearchPill", () => {
  it("is a button that announces the dialog it opens and its shortcut", () => {
    const html = pill(false);
    expect(html).toMatch(/^<button type="button"/);
    expect(html).toContain('aria-haspopup="dialog"');
    expect(html).toContain('aria-expanded="false"');
    expect(html).toContain('aria-keyshortcuts="Control+K"');
    expect(html).not.toContain("<input");
  });

  it("says it is open while the finder is up", () => {
    expect(pill(true)).toContain('aria-expanded="true"');
  });

  it("names itself by its visible word and hides the hint from the reader", () => {
    const html = pill(false);
    expect(html).toMatch(/data-pill-label="">Search</);
    expect(html).toMatch(/data-pill-hint="" aria-hidden="true">Ctrl\+K</);
  });
});

describe("Sidebar search pill", () => {
  it("heads the rail, above Home, when the finder can open", () => {
    const html = rail({ search });
    expect(html).toContain('aria-haspopup="dialog"');
    expect(html.indexOf('aria-haspopup="dialog"')).toBeLessThan(html.indexOf(">Home<"));
  });

  it("is absent where the finder cannot open", () => {
    expect(rail({ search: null })).not.toContain('aria-haspopup="dialog"');
    expect(rail()).not.toContain('aria-haspopup="dialog"');
  });

  it("is absent from a bare rail", () => {
    expect(rail({ search, bare: true })).not.toContain('aria-haspopup="dialog"');
  });
});
