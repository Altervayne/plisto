// -- Framework Imports --
import { isValidElement } from "react";
import type { ReactElement, ReactNode } from "react";

// -- Test Imports --
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

// -- Unit Imports --
import { CatalogTile } from "./CatalogTile";
import { FamilyBlock } from "./FamilyBlock";
import { VisualizersSection } from "./VisualizersSection";
import { catalogFamilies } from "./useCatalogRows";
import { QuietButton } from "../../common/QuietButton";
import { Switch } from "../../common/Switch/Switch";
import { SETTINGS_SECTIONS } from "../settingsSections";
import { SETTINGS_REGISTRY } from "../settingsRegistry";

// -- State Imports --
import { PREF_KEYS, usePreferencesStore } from "../../../state/preferences/store";
import { buildCatalog, serializeCatalog, toggleGroup, toggleKind } from "../../../state/player/visualizerCatalog";
import { GROUP_ORDER } from "../../../state/player/visualizerRegistry";

// -- i18n Imports --
import { en } from "../../../i18n/en";

const h = vi.hoisted(() => ({ setSetting: vi.fn((_key: string, _value: string) => Promise.resolve()), dark: false }));

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
  setSetting: h.setSetting,
}));
vi.mock("../../../theme", () => ({ useTheme: () => "system", isDarkTheme: () => h.dark }));

const KEY = PREF_KEYS.playerVisualizerCatalog;
const catalogOf = (kinds: string[], groups: string[] = []) =>
  buildCatalog(serializeCatalog({ kinds, groups }), false);
const ALL_KINDS = catalogOf([]).entries.map((e) => e.id);

function setPrefs(values: Record<string, string>, opts: { loaded?: boolean; failed?: boolean } = {}): void {
  usePreferencesStore.setState({
    values,
    failedKeys: new Set(opts.failed ? [KEY] : []),
    loaded: opts.loaded ?? true,
  });
}

/** Every element in a tree, depth first. */
function elements(node: ReactNode, out: ReactElement<Record<string, unknown>>[] = []) {
  if (Array.isArray(node)) node.forEach((n) => elements(n, out));
  else if (isValidElement<Record<string, unknown>>(node)) {
    out.push(node);
    elements(node.props.children as ReactNode, out);
  }
  return out;
}

/** The element tree a component function returns, with hooks run inside a render. */
function treeOf(render: () => ReactNode): ReactElement<Record<string, unknown>>[] {
  let out: ReactElement<Record<string, unknown>>[] = [];
  function Probe() {
    out = elements(render());
    return null;
  }
  renderToStaticMarkup(<Probe />);
  return out;
}

function blockTree(familyId: string, catalog: ReturnType<typeof catalogOf>, onChange = vi.fn()) {
  const family = catalogFamilies(catalog).find((f) => f.id === familyId)!;
  return { onChange, tree: treeOf(() => FamilyBlock({ family, catalog, onChange })) };
}

const switchesOf = (tree: ReactElement<Record<string, unknown>>[]) => tree.filter((e) => e.type === Switch);
const tilesOf = (tree: ReactElement<Record<string, unknown>>[]) => tree.filter((e) => e.type === CatalogTile);
const lineOf = (tree: ReactElement<Record<string, unknown>>[], text: string) =>
  tree.filter((e) => e.type === "span" && e.props.children === text);

/** The switch of one kind tile: the tile is expanded so its Switch shows in the tree. */
function kindSwitch(tree: ReactElement<Record<string, unknown>>[], id: string) {
  const tile = tilesOf(tree).find((x) => (x.props.row as { id: string }).id === id)!;
  const props = tile.props as unknown as Parameters<typeof CatalogTile>[0];
  return switchesOf(treeOf(() => CatalogTile(props)))[0];
}

beforeEach(() => {
  vi.clearAllMocks();
  h.dark = false;
  setPrefs({});
});

describe("catalogFamilies", () => {
  it("lists the families in registry order with plain-string rows", () => {
    const families = catalogFamilies(catalogOf([]));
    expect(families.map((f) => f.id)).toEqual([...GROUP_ORDER]);
    for (const row of families.flatMap((f) => f.rows)) {
      expect(row.source).toBe("builtin");
      expect(typeof row.id).toBe("string");
    }
  });
});

describe("registry and sections", () => {
  it("files the catalog row under a Visualizers section after Sound", () => {
    const ids = SETTINGS_SECTIONS.map((s) => s.id);
    expect(ids.indexOf("visualizers")).toBe(ids.indexOf("sound") + 1);
    expect(SETTINGS_REGISTRY.filter((e) => e.section === "visualizers").map((e) => e.id)).toEqual([
      "visualizerCatalog",
    ]);
  });

  it("has no per-kind row and no visibility predicate", () => {
    const entry = SETTINGS_REGISTRY.find((e) => e.id === "visualizerCatalog")!;
    expect(entry.visible).toBeUndefined();
  });
});

describe("VisualizersSection", () => {
  it("stamps the section and the one catalog row, with a switch per kind and per family", () => {
    const html = renderToStaticMarkup(<VisualizersSection />);
    expect(html).toContain('data-settings-section="visualizers"');
    expect(html).toContain('data-setting-id="visualizerCatalog"');
    expect((html.match(/role="switch"/g) ?? []).length).toBe(ALL_KINDS.length + GROUP_ORDER.length);
    expect(html).toContain(`${ALL_KINDS.length} of ${ALL_KINDS.length} on`);
  });

  it("names every switch by its kind or family", () => {
    const html = renderToStaticMarkup(<VisualizersSection />);
    expect(html).toContain(`aria-label="${en.player.visualizerRidge}"`);
    expect(html).toContain(`aria-label="${en.player.visualizerGroupCozy}"`);
    expect(html).toContain(`aria-label="${en.player.visualizerGroupCyber}"`);
    expect(html).toContain(`aria-label="${en.player.visualizerHologram}"`);
    expect(html).toContain(`aria-label="${en.player.visualizerGroupCosmic}"`);
    expect(html).toContain(`aria-label="${en.player.visualizerRingedPlanet}"`);
    expect(html).toContain(`aria-label="${en.player.visualizerStation}"`);
    expect(html).toContain(`aria-label="${en.player.visualizerSolarFlare}"`);
    expect(html).toContain(`aria-label="${en.player.visualizerEventHorizon}"`);
  });

  it("disables every switch and says it is reading before the preferences load", () => {
    setPrefs({}, { loaded: false });
    const html = renderToStaticMarkup(<VisualizersSection />);
    expect(html).toContain(en.settings.visualizersReading);
    expect(html).not.toContain(en.settings.visualizersRetry);
    expect(html.match(/role="switch"/g)!.length).toBe(html.match(/<button[^>]*disabled=""[^>]*role="switch"|role="switch"[^>]*disabled=""/g)!.length);
  });

  it("disables every switch and offers a retry when the read failed", () => {
    setPrefs({}, { failed: true });
    const html = renderToStaticMarkup(<VisualizersSection />);
    expect(html).toContain(en.settings.visualizersFailed);
    expect(html).toContain(en.settings.visualizersRetry);
    const switches = html.match(/<button[^>]*role="switch"[^>]*>/g)!;
    expect(switches.every((s) => s.includes("disabled"))).toBe(true);
  });

  it("treats a newer stored version like a failed read", () => {
    setPrefs({ [KEY]: '{"v":2,"kinds":[],"groups":[]}' });
    expect(renderToStaticMarkup(<VisualizersSection />)).toContain(en.settings.visualizersFailed);
  });

  it("retries the one catalog key", () => {
    setPrefs({}, { failed: true });
    const retry = vi.fn(() => Promise.resolve());
    usePreferencesStore.setState({ retryPreference: retry });
    const tree = treeOf(() => VisualizersSection());
    const button = tree.find((e) => e.type === QuietButton)!;
    (button.props.onClick as () => void)();
    expect(retry).toHaveBeenCalledWith(KEY);
  });
});

describe("FamilyBlock", () => {
  it("writes the kind toggle through the stored string", () => {
    const { tree, onChange } = blockTree("cozy", catalogOf([]));
    const train = tilesOf(tree).find((t) => (t.props.row as { id: string }).id === "train")!;
    (train.props.onChange as (on: boolean) => void)(false);
    expect(onChange).toHaveBeenCalledWith({ kinds: ["train"], groups: [] });
  });

  it("hands the family and kind switches the exact toggle results", () => {
    const catalog = catalogOf(["window"]);
    const { tree, onChange } = blockTree("cozy", catalog);
    const family = switchesOf(tree).find((s) => s.props.label === en.player.visualizerGroupCozy)!;
    (family.props.onChange as (on: boolean) => void)(false);
    expect(onChange).toHaveBeenLastCalledWith(toggleGroup(catalog, "cozy"));
    expect(onChange).not.toHaveBeenLastCalledWith(toggleKind(catalog, "cozy"));

    const kind = kindSwitch(tree, "train");
    (kind.props.onChange as (on: boolean) => void)(false);
    expect(onChange).toHaveBeenLastCalledWith(toggleKind(catalog, "train"));
    expect(onChange).not.toHaveBeenLastCalledWith(toggleGroup(catalog, "train"));
    expect(toggleKind(catalog, "train")).not.toEqual(toggleGroup(catalog, "cozy"));
  });

  it("writes the toggle result as the stored string", async () => {
    const { persistVisualizerCatalog } = await import("../../../state/preferences/store");
    persistVisualizerCatalog(toggleGroup(catalogOf([]), "cozy"));
    expect(h.setSetting).toHaveBeenCalledWith(KEY, '{"v":1,"kinds":[],"groups":["cozy"]}');
  });

  it("shows the family-off line and disables the kind switches at their own state", () => {
    const { tree } = blockTree("cozy", catalogOf(["train"], ["cozy"]));
    expect(lineOf(tree, en.settings.visualizersFamilyOff)).toHaveLength(1);
    const train = kindSwitch(tree, "train");
    const lake = kindSwitch(tree, "lake");
    expect(train.props.disabled).toBe(true);
    expect(train.props.checked).toBe(false);
    expect(lake.props.disabled).toBe(true);
    expect(lake.props.checked).toBe(true);
  });

  it("says nothing while several kinds stay on, and locks the last one with a line", () => {
    const rest = ALL_KINDS.filter((id) => id !== "ridge" && id !== "terrain");
    const several = blockTree("classic", catalogOf(rest)).tree;
    expect(lineOf(several, en.settings.visualizersLastOn)).toHaveLength(0);
    expect(switchesOf(several)[0].props.disabled).toBe(true);
    expect(kindSwitch(several, "ridge").props.disabled).toBe(false);

    const one = blockTree("classic", catalogOf([...rest, "terrain"])).tree;
    expect(lineOf(one, en.settings.visualizersLastOn)).toHaveLength(1);
    expect(kindSwitch(one, "ridge").props.disabled).toBe(true);
  });

  it("reads a family with some kinds off as on with a count", () => {
    const { tree } = blockTree("cozy", catalogOf(["train", "window"]));
    expect(switchesOf(tree)[0].props.checked).toBe(true);
    expect(renderToStaticMarkup(<>{elements(tree[0])[0].props.children as ReactNode}</>)).toContain("6 of 8 on");
  });

  it("reads a family whose kinds are all off as on, with every kind switch enabled", () => {
    const cozy = catalogFamilies(catalogOf([])).find((f) => f.id === "cozy")!.rows.map((r) => r.id);
    const { tree } = blockTree("cozy", catalogOf(cozy));
    expect(switchesOf(tree)[0].props.checked).toBe(true);
    for (const tile of tilesOf(tree)) {
      expect(tile.props.on).toBe(false);
      expect(tile.props.disabled).toBe(false);
    }
  });

  it("disables the kinds of an off family and keeps their own state", () => {
    const { tree } = blockTree("cozy", catalogOf(["train"], ["cozy"]));
    expect(switchesOf(tree)[0].props.checked).toBe(false);
    const tiles = tilesOf(tree);
    expect(tiles.every((t) => t.props.disabled === true && t.props.dimmed === true)).toBe(true);
    expect(tiles.find((t) => (t.props.row as { id: string }).id === "train")!.props.on).toBe(false);
    expect(tiles.find((t) => (t.props.row as { id: string }).id === "lake")!.props.on).toBe(true);
  });

  it("locks the last kind and its family, and shows the guard line there", () => {
    const only = ALL_KINDS.filter((id) => id !== "ridge");
    const catalog = catalogOf(only);
    const { tree } = blockTree("classic", catalog);
    const ridge = tilesOf(tree).find((t) => (t.props.row as { id: string }).id === "ridge")!;
    expect(ridge.props.disabled).toBe(true);
    expect(ridge.props.lockedNote).toBe(en.settings.visualizersLastOn);
    expect(switchesOf(tree)[0].props.disabled).toBe(true);
    const html = renderToStaticMarkup(<>{tree[0].props.children as ReactNode}</>);
    expect(html).toContain(en.settings.visualizersLastOn);
    // Another family still lets a kind come back on.
    const other = blockTree("dots", catalog).tree;
    expect(tilesOf(other).every((t) => t.props.disabled === false)).toBe(true);
  });

  it("disables every switch while the catalog is not writable", () => {
    const catalog = buildCatalog(undefined, true);
    const { tree } = blockTree("classic", catalog);
    expect(switchesOf(tree)[0].props.disabled).toBe(true);
    expect(tilesOf(tree).every((t) => t.props.disabled === true)).toBe(true);
  });
});

describe("CatalogTile", () => {
  const row = catalogFamilies(catalogOf([])).flatMap((f) => f.rows).find((r) => r.id === "ridge")!;
  const props = { row, on: true, dimmed: false, disabled: false, onChange: () => {} };

  it("loads its still lazily and swaps it with the theme", () => {
    h.dark = false;
    const light = renderToStaticMarkup(<CatalogTile {...props} />);
    h.dark = true;
    const dark = renderToStaticMarkup(<CatalogTile {...props} />);
    expect(light).toContain('loading="lazy"');
    expect(light.match(/src="([^"]*)"/)![1]).not.toBe(dark.match(/src="([^"]*)"/)![1]);
  });

  it("names its switch by the kind", () => {
    const html = renderToStaticMarkup(<CatalogTile {...props} />);
    expect(html).toContain(`aria-label="${en.player.visualizerRidge}"`);
  });
});
