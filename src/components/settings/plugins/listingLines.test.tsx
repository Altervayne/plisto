// -- Test Imports --
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

// The server renderer reads a store's initial state, so hooks read the live state through this stand-in.
vi.mock("zustand", async (orig) => {
  const real = await orig<typeof import("zustand")>();
  const create = ((init: never) => {
    const store = real.create(init);
    const hook = (select: (s: unknown) => unknown = (s) => s) => select(store.getState());
    return Object.assign(hook, store);
  }) as unknown as typeof real.create;
  return { ...real, create };
});
// The confirm dialog portals to the document body; the stand-in draws its content in place.
vi.mock("../../common/ConfirmDialog/ConfirmDialog", () => ({
  ConfirmDialog: ({ children }: { children: unknown }) => <>{children}</>,
}));
vi.mock("../../../state/plugins/usePluginStatusView", async () => {
  const { statusView } = await import("../../../state/plugins/statusModel");
  return { usePluginStatusView: (r: PluginRow) => statusView("running", r, undefined) };
});

// -- Unit Imports --
import { PluginRowPanel } from "./PluginRowPanel";
import { PluginsSection } from "./PluginsSection";
import { UninstallDialog } from "./UninstallDialog";
import { manifest, row, visualizerDecl, visualizerRow } from "../../../state/plugins/fixtures";
import { firstCatalogFamily } from "../../shell/navVisibility";

// -- State Imports --
import { usePluginsStore } from "../../../state/plugins/store";

// -- i18n Imports --
import { en } from "../../../i18n/en";

// -- Type Imports --
import type { PluginRow } from "../../../types";

const decls = [visualizerDecl({ id: "a", name: "A" }), visualizerDecl({ id: "b", name: "B" })];
const withPage = (over: Partial<PluginRow> = {}) =>
  row({ id: "setlist", manifest: manifest({ name: "Setlist Pro", visualizers: decls }), ...over });
const only = (id: string) => visualizerRow(id, id, [visualizerDecl()]);

const panel = (r: PluginRow) =>
  renderToStaticMarkup(<PluginRowPanel row={r} busy={false} onToggle={() => {}} onUninstall={() => {}} />);
const section = () => renderToStaticMarkup(<PluginsSection />);

beforeEach(() => {
  usePluginsStore.setState({ rows: [], status: "ready" });
});

describe("a plugins-list panel for a plugin that adds visualizers", () => {
  it("says how many it adds and links to its family", () => {
    const html = panel(withPage());
    expect(html).toContain("Adds 2 visualizers");
    expect(html).toContain(en.plugins.vis.showInVisualizers);
  });

  it("says it in the singular for one", () => {
    const one = withPage({ manifest: manifest({ visualizers: [visualizerDecl()] }) });
    expect(panel(one)).toContain("Adds 1 visualizer.");
  });

  it("does not say it for a plugin that adds none", () => {
    expect(panel(row())).not.toContain(en.plugins.vis.showInVisualizers);
  });

  it("still says it while the plugin is off, and offers only Uninstall", () => {
    const html = panel(withPage({ enabled: false }));
    expect(html).toContain("Adds 2 visualizers");
    expect(html).toContain(en.plugins.uninstall);
    expect(html).not.toContain(en.plugins.disable);
    expect(html).not.toContain(en.plugins.ui.openSettings);
    expect(html).not.toContain(en.plugins.frame.restart);
  });
});

describe("the plugins list with visualizer plugins", () => {
  it("says how many are managed in Visualizers, with a link", () => {
    usePluginsStore.setState({ rows: [row(), only("a"), only("b")] });
    const html = section();
    expect(html).toContain("2 visualizer plugins are managed in");
    expect(html).toContain(en.plugins.vis.managedLink);
  });

  it("says it in the singular for one", () => {
    usePluginsStore.setState({ rows: [row(), only("a")] });
    expect(section()).toContain("1 visualizer plugin is managed in");
  });

  it("takes the place of the empty line when only visualizer plugins are installed", () => {
    usePluginsStore.setState({ rows: [only("a")] });
    const html = section();
    expect(html).toContain("1 visualizer plugin is managed in");
    expect(html).not.toContain(en.plugins.empty);
  });

  it("shows the plain empty line, and no managed line, when nothing is installed", () => {
    const html = section();
    expect(html).toContain(en.plugins.empty);
    expect(html).not.toContain("managed in");
  });

  it("does not list a visualizer-only plugin as a row", () => {
    usePluginsStore.setState({ rows: [only("a")] });
    expect(section()).not.toContain("setting-hub-a");
  });
});

describe("the uninstall dialog", () => {
  const dialog = (r: PluginRow) =>
    renderToStaticMarkup(<UninstallDialog row={r} busy={false} onConfirm={() => {}} onClose={() => {}} />);

  it("says that picks of a plugin's visualizers go back to the default", () => {
    expect(dialog(only("a"))).toContain(en.plugins.vis.uninstallFallback);
  });

  it("leaves that line out for a plugin with no visualizers", () => {
    expect(dialog(row())).not.toContain(en.plugins.vis.uninstallFallback);
  });
});

describe("the first catalog family", () => {
  it("is the catalog plugin first by name, and none when the list has no catalog plugin", () => {
    const named = (id: string, name: string) => visualizerRow(id, name, [visualizerDecl()]);
    expect(firstCatalogFamily([named("z", "Zed"), named("a", "Alpha"), row()])).toBe("a");
    expect(firstCatalogFamily([row()])).toBeNull();
  });
});
