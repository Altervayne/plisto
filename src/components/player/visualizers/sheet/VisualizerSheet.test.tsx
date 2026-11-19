// -- Test Imports --
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

// -- Unit Imports --
import { GroupChips } from "./GroupChips";
import { VisualizerSheet } from "./VisualizerSheet";
import { currentGroup, sheetGroupsOf } from "./sheetGroups";
import { useSheetGroups } from "./useSheetGroups";

// -- State Imports --
import { PREF_KEYS, usePreferencesStore } from "../../../../state/preferences/store";
import { useVisualizerSheet } from "../../../../state/player/visualizerSheet";
import { buildCatalog, serializeCatalog } from "../../../../state/player/visualizerCatalog";
import { resolveVisualizer, type ResolveInput } from "../../../../state/player/visualizerResolve";

const h = vi.hoisted(() => ({ resolved: null as unknown }));

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
vi.mock("../../../../theme", () => ({ useTheme: () => "system", isDarkTheme: () => false }));
vi.mock("../useVisualizerResolution", () => ({ useVisualizerResolution: () => h.resolved }));
vi.mock("../useVisualizerPick", () => ({ useVisualizerPick: () => vi.fn() }));
vi.mock("../useWarmVisualizers", () => ({ useWarmSheetKinds: () => undefined }));

const catalogOf = (kinds: string[], groups: string[] = []) =>
  buildCatalog(serializeCatalog({ kinds, groups }), false);

function setCatalog(kinds: string[], groups: string[] = []): void {
  usePreferencesStore.setState({
    values: { [PREF_KEYS.playerVisualizerCatalog]: serializeCatalog({ kinds, groups }) },
    failedKeys: new Set<string>(),
    loaded: true,
  });
}

function resolve(global: string, catalog: ReturnType<typeof catalogOf>) {
  const input: ResolveInput = {
    global: global as never,
    trackDefault: null,
    albumDefault: null,
    override: null,
    albumKey: "album:7",
    catalog,
  };
  h.resolved = { place: { kind: "album", trackId: 3, albumId: 7 }, input, resolution: resolveVisualizer(input) };
}

function renderSheet(global: string, kinds: string[], groups: string[]): string {
  setCatalog(kinds, groups);
  resolve(global, catalogOf(kinds, groups));
  useVisualizerSheet.setState({ isOpen: true });
  return renderToStaticMarkup(<VisualizerSheet place="player" trackId={3} />);
}

// The reactivity segments share the pressed-button markup, so they are filtered out.
const chipLabels = (html: string) =>
  [...html.matchAll(/aria-pressed="(?:true|false)"[^>]*>([^<]+)/g)]
    .map((m) => m[1])
    .filter((label) => !["Calm", "Balanced", "Lively"].includes(label));

beforeEach(() => {
  useVisualizerSheet.setState({ isOpen: false });
});

describe("VisualizerSheet chips", () => {
  it("has no chip row with one family and Off", () => {
    const html = renderSheet("train", [], ["classic", "dots", "fluid", "cyber", "cosmic"]);
    expect(chipLabels(html)).toEqual([]);
    expect(html).toContain('data-group="cozy"');
    expect(html).toContain('data-group="off"');
  });

  it("has a chip row with two families and Off", () => {
    const html = renderSheet("ridge", [], ["dots", "fluid", "cyber", "cosmic"]);
    expect(chipLabels(html)).toEqual(["Classic", "Cozy", "Off"]);
  });

  it("lists the Cyber family after Cozy when it is on", () => {
    const html = renderSheet("ridge", [], ["dots", "fluid", "cosmic"]);
    expect(chipLabels(html)).toEqual(["Classic", "Cozy", "Cyber", "Off"]);
  });

  it("lists the Cosmic family after Cyber when it is on", () => {
    const html = renderSheet("ridge", [], ["dots", "fluid"]);
    expect(chipLabels(html)).toEqual(["Classic", "Cozy", "Cyber", "Cosmic", "Off"]);
  });

  it("runs the strip over the offered families only, Off last", () => {
    const html = renderSheet("ridge", ["train"], ["dots"]);
    const groups = [...html.matchAll(/data-group="([^"]+)"/g)].map((m) => m[1]);
    expect(groups).toEqual(["classic", "fluid", "cozy", "cyber", "cosmic", "off"]);
    expect(html).not.toContain('data-kind="train"');
  });
});

describe("VisualizerSheet warning line and marks", () => {
  const LINE = "Some visualizers can flash. Calm reduces the reaction.";

  it("shows the line with every family on", () => {
    expect(renderSheet("ridge", [], [])).toContain(LINE);
  });

  it("shows the line with only Cozy offered, where the chips are hidden", () => {
    const html = renderSheet("train", [], ["classic", "dots", "fluid", "cyber", "cosmic"]);
    expect(chipLabels(html)).toEqual([]);
    expect(html).toContain(LINE);
  });

  it("marks the families in the strip headings and, icon-only, on the chips", () => {
    const html = renderSheet("ridge", [], []);
    expect(html.match(/>Can flash</g)).toHaveLength(2);
    expect(html.match(/>Calmer</g)).toHaveLength(1);
    expect(html.match(/aria-label="Can flash"/g)).toHaveLength(2);
    expect(html.match(/aria-label="Calmer"/g)).toHaveLength(1);
  });

  it("marks the lone Cozy heading when the chips are hidden", () => {
    const html = renderSheet("train", [], ["classic", "dots", "fluid", "cyber", "cosmic"]);
    expect(html.match(/>Calmer</g)).toHaveLength(1);
  });
});

describe("VisualizerSheet manage link", () => {
  it("is offered in the Player", () => {
    const html = renderSheet("ridge", [], []);
    expect(html).toContain("Manage visualizers");
  });

  it("is absent in the ambient view", () => {
    setCatalog([], []);
    resolve("ridge", catalogOf([], []));
    useVisualizerSheet.setState({ isOpen: true });
    const html = renderToStaticMarkup(<VisualizerSheet place="ambient" trackId={3} />);
    expect(html).not.toContain("Manage visualizers");
  });
});

describe("VisualizerSheet checked tile", () => {
  it("renders the resolved kind checked in the strip", () => {
    const html = renderSheet("glass", [], []);
    expect(html.match(/aria-checked="true"/g)).toHaveLength(1);
    expect(html).toMatch(/data-kind="glass"[^>]*aria-checked="true"|aria-checked="true"[^>]*data-kind="glass"/);
  });

  it("falls to the fallback tile when the global pick is turned off", () => {
    const html = renderSheet("train", ["train"], []);
    expect(html).not.toContain('data-kind="train"');
    expect(html).toMatch(/data-kind="ridge"[^>]*aria-checked="true"|aria-checked="true"[^>]*data-kind="ridge"/);
  });

  it("checks Off when Off is the pick", () => {
    const html = renderSheet("off", [], ["dots", "fluid"]);
    expect(html).toMatch(/data-kind="off"[^>]*aria-checked="true"|aria-checked="true"[^>]*data-kind="off"/);
  });
});

describe("GroupChips and the current group", () => {
  const groups = sheetGroupsOf(catalogOf([]));

  it("raises the current chip", () => {
    const html = renderToStaticMarkup(<GroupChips groups={groups} current="fluid" onJump={() => undefined} />);
    expect(html.match(/aria-pressed="true"[^>]*>([^<]+)/)?.[1]).toBe("Fluid");
  });

  it("falls back to the first run when the picked family vanishes", () => {
    const left = sheetGroupsOf(catalogOf([], ["fluid"]));
    expect(currentGroup(left, "fluid")).toBe("classic");
    expect(currentGroup(left, "cozy")).toBe("cozy");
    const html = renderToStaticMarkup(
      <GroupChips groups={left} current={currentGroup(left, "fluid")} onJump={() => undefined} />,
    );
    expect(html.match(/aria-pressed="true"[^>]*>([^<]+)/)?.[1]).toBe("Classic");
  });
});

describe("useSheetGroups", () => {
  function probe(): ReturnType<typeof useSheetGroups> {
    let out!: ReturnType<typeof useSheetGroups>;
    function Probe() {
      out = useSheetGroups();
      return null;
    }
    renderToStaticMarkup(<Probe />);
    return out;
  }

  it("returns one reference while the catalog does not change", () => {
    setCatalog(["train"], []);
    const first = probe();
    usePreferencesStore.setState({ values: { ...usePreferencesStore.getState().values, unrelated: "1" } });
    expect(probe()).toBe(first);
  });

  it("returns new groups once the catalog changes", () => {
    setCatalog([], []);
    const first = probe();
    setCatalog([], ["dots"]);
    expect(probe()).not.toBe(first);
    expect(probe().map((g) => g.id)).toEqual(["classic", "fluid", "cozy", "cyber", "cosmic", "off"]);
  });
});
