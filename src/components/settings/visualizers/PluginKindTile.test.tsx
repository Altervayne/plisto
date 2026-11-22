// -- Test Imports --
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

// -- Unit Imports --
import { CatalogTile } from "./CatalogTile";
import { PluginKindTile, turnBackOn } from "./PluginKindTile";
import { catalogFamilies } from "./useCatalogRows";
import { ID, RUNNING, catalog, only, treeOf } from "./familyTestKit";
import { TextLink } from "../../plugins/TextLink";

// -- State Imports --
import { resetNetPolicy, useNetPolicy } from "../../../state/player/pluginVis/netPolicy";
import { PREF_KEYS, usePreferencesStore } from "../../../state/preferences/store";
import { usePluginsStore } from "../../../state/plugins/store";

// -- i18n Imports --
import { en } from "../../../i18n/en";

const h = vi.hoisted(() => ({
  clearMark: vi.fn((_id: string, _kind: string) => Promise.resolve()),
  marks: vi.fn(() => Promise.resolve([] as unknown[])),
}));

// A static render reads a store's initial state; hooks read the live state instead.
vi.mock("zustand", async (orig) => {
  const real = await orig<typeof import("zustand")>();
  const create = ((init: never) => {
    const store = real.create(init);
    const hook = (select: (s: unknown) => unknown = (s) => s) => select(store.getState());
    return Object.assign(hook, store);
  }) as unknown as typeof real.create;
  return { ...real, create };
});
vi.mock("../../../lib/ipc", async (orig) => ({
  ...(await orig<typeof import("../../../lib/ipc")>()),
  pluginVisClearMark: h.clearMark,
  pluginVisMarks: h.marks,
}));
vi.mock("../../../theme", () => ({ useTheme: () => "system", isDarkTheme: () => false }));
beforeEach(() => {
  vi.clearAllMocks();
  resetNetPolicy();
  usePluginsStore.setState({ rows: [] });
  usePreferencesStore.setState({ values: {}, failedKeys: new Set(), loaded: true });
});

describe("a plugin tile's marks", () => {
  const kind = `${ID}/rings`;
  const catalogRow = () => catalogFamilies(catalog, { rows: [only()], boot: RUNNING, statuses: {} })
    .find((f) => f.plugin)!.rows[0];
  const mark = (over: Record<string, boolean>) =>
    useNetPolicy.setState({
      loaded: true,
      marks: {
        [kind]: {
          id: ID,
          kind: "rings",
          flashing: false,
          graphics_reset: false,
          turned_back_on: false,
          trialed: false,
          ...over,
        },
      },
    });
  const tileProps = () => ({
    row: catalogRow(),
    on: true,
    dimmed: false,
    disabled: false,
    onChange: () => {},
  });
  const tile = () => renderToStaticMarkup(<PluginKindTile {...tileProps()} />);

  it("says a graphics reset stopped the kind, whatever the setting", () => {
    mark({ graphics_reset: true });
    const out = tile();
    expect(out).toContain(en.plugins.vis.stoppedReset);
    expect(out).toContain(en.plugins.vis.turnBackOn);
  });

  it("says flashing stopped the kind only while the setting is on", () => {
    mark({ flashing: true });
    expect(tile()).not.toContain(en.plugins.vis.stoppedFlash);
    usePreferencesStore.setState({ values: { [PREF_KEYS.playerVisualizerStopFlashing]: "1" } });
    expect(tile()).toContain(en.plugins.vis.stoppedFlash);
  });

  it("leaves a kind turned back on alone", () => {
    usePreferencesStore.setState({ values: { [PREF_KEYS.playerVisualizerStopFlashing]: "1" } });
    mark({ flashing: true, turned_back_on: true });
    expect(tile()).not.toContain(en.plugins.vis.stoppedFlash);
  });

  it("clears the mark and then reads the marks again when Turn back on is pressed", async () => {
    mark({ graphics_reset: true });
    const shown = treeOf(() => PluginKindTile(tileProps())).find((e) => e.type === CatalogTile)!;
    const stop = shown.props.stop as { onTurnBack: () => void };
    stop.onTurnBack();
    await Promise.resolve();
    await Promise.resolve();
    expect(h.clearMark).toHaveBeenCalledWith(ID, "rings");
    expect(h.marks).toHaveBeenCalled();
  });

  it("drops a mark that a failed write kept for the session, so the tile stops reading Stopped", async () => {
    useNetPolicy.setState({ pending: { [kind]: { mark: "graphics_reset", after: null } } });
    await expect(turnBackOn(kind)).resolves.toBe(true);
    expect(useNetPolicy.getState().pending[kind]).toBeUndefined();
  });

  it("says so on the tile when the clear is refused", async () => {
    h.clearMark.mockRejectedValueOnce(new Error("no"));
    vi.spyOn(console, "warn").mockImplementation(() => {});
    await expect(turnBackOn(kind)).resolves.toBe(false);
    const out = renderToStaticMarkup(
      <CatalogTile
        row={catalogRow()}
        on
        dimmed={false}
        disabled={false}
        stop={{ cause: "reset", onTurnBack: () => {} }}
        turnBackFailed
        onChange={() => {}}
      />,
    );
    expect(out).toContain(en.plugins.vis.turnBackFailed);
  });

  it("shows the Turn back on link on the tile itself", () => {
    const stop = { cause: "reset" as const, onTurnBack: vi.fn() };
    const link = treeOf(() => CatalogTile({ ...tileProps(), stop })).find((e) => e.type === TextLink)!;
    (link.props.onClick as () => void)();
    expect(stop.onTurnBack).toHaveBeenCalledTimes(1);
  });

  it("says a kind with no canvas for the meter is not watched, on the tile", () => {
    const out = renderToStaticMarkup(
      <CatalogTile row={catalogRow()} on dimmed={false} disabled={false} unwatched onChange={() => {}} />,
    );
    expect(out).toContain(en.plugins.vis.notWatched);
    expect(out).not.toContain(en.plugins.vis.turnBackOn);
  });
});
