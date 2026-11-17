// -- Test Imports --
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

// -- Unit Imports --
import { useVisualizerResolution } from "./useVisualizerResolution";
import { useWarmCurrentVisualizer, useWarmSheetKinds } from "./useWarmVisualizers";

// -- State Imports --
import { PREF_KEYS, usePreferencesStore } from "../../../state/preferences/store";
import { useVisualizerDefaults } from "../../../state/player/visualizerDefaults";
import { serializeCatalog } from "../../../state/player/visualizerCatalog";

const h = vi.hoisted(() => ({
  setSetting: vi.fn(() => Promise.resolve()),
  warmKind: vi.fn(),
  trackId: 3,
}));

// Effects run in place, so a static render exercises them.
vi.mock("react", async (orig) => ({ ...(await orig<typeof import("react")>()), useEffect: (fn: () => void) => void fn() }));
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
vi.mock("../../../state/organize/store", () => ({
  useAlbumIndex: () => ALBUM_INDEX,
}));
vi.mock("../../../state/player/store", () => ({
  usePlayerStatus: () => ({ track_id: h.trackId }),
  usePlayerStore: { getState: () => ({ status: { track_id: h.trackId } }) },
}));
vi.mock("./gl/warm", () => ({
  warmKind: h.warmKind,
  whenIdle: (run: () => void) => {
    run();
    return () => {};
  },
}));

const ALBUM_INDEX = new Map([[3, { id: 7, kind: "album" as const }]]);

/** Calls a hook once inside a static render and returns what it gave. */
function probe<T>(hook: () => T): T {
  let out!: T;
  function Probe() {
    out = hook();
    return null;
  }
  renderToStaticMarkup(<Probe />);
  return out;
}

function setPrefs(values: Record<string, string>, loaded = true): void {
  usePreferencesStore.setState({ values, failedKeys: new Set<string>(), loaded });
}

function setDefaults(
  albums: Record<number, string>,
  tracks: Record<number, string> = {},
  status: "loading" | "ready" = "ready",
): void {
  useVisualizerDefaults.setState({ status, albums, tracks, override: null });
}

const turnedOff = (kinds: string[]) => serializeCatalog({ kinds, groups: [] });

beforeEach(() => {
  vi.clearAllMocks();
  setPrefs({});
  setDefaults({});
});

describe("useVisualizerResolution", () => {
  it("resolves a turned-off global pick to the fallback without writing a setting", () => {
    setPrefs({ [PREF_KEYS.playerVisualizer]: "ridge", [PREF_KEYS.playerVisualizerCatalog]: turnedOff(["ridge"]) });
    const { resolution } = probe(() => useVisualizerResolution(3));
    expect(resolution.picked).not.toBe("ridge");
    expect(resolution.source).toBe("global");
    expect(h.setSetting).not.toHaveBeenCalled();
  });

  it("skips a turned-off album default and leaves the stored default in place", () => {
    setDefaults({ 7: "nebula" });
    setPrefs({ [PREF_KEYS.playerVisualizerCatalog]: turnedOff(["nebula"]) });
    const { resolution } = probe(() => useVisualizerResolution(3));
    expect(resolution.picked).toBe("ridge");
    expect(resolution.skipped).toEqual({ kind: "nebula", tier: "album" });
    expect(useVisualizerDefaults.getState().albums).toEqual({ 7: "nebula" });
    expect(h.setSetting).not.toHaveBeenCalled();
  });

  it("offers everything before the preferences load", () => {
    setDefaults({ 7: "nebula" });
    setPrefs({ [PREF_KEYS.playerVisualizerCatalog]: turnedOff(["nebula"]) }, false);
    expect(probe(() => useVisualizerResolution(3)).resolution.picked).toBe("nebula");
  });
});

describe("useWarmCurrentVisualizer", () => {
  it("waits for the preferences", () => {
    setDefaults({ 7: "nebula" });
    setPrefs({}, false);
    probe(useWarmCurrentVisualizer);
    expect(h.warmKind).not.toHaveBeenCalled();
  });

  it("waits for the stored defaults", () => {
    setDefaults({}, {}, "loading");
    probe(useWarmCurrentVisualizer);
    expect(h.warmKind).not.toHaveBeenCalled();
  });

  it("warms the resolved kind", () => {
    setDefaults({ 7: "nebula" });
    probe(useWarmCurrentVisualizer);
    expect(h.warmKind.mock.calls).toEqual([["nebula"]]);
  });

  it("warms the next tier when the default is turned off", () => {
    setDefaults({ 7: "nebula" });
    setPrefs({ [PREF_KEYS.playerVisualizerCatalog]: turnedOff(["nebula"]) });
    probe(useWarmCurrentVisualizer);
    expect(h.warmKind.mock.calls).toEqual([["ridge"]]);
  });
});

describe("useWarmSheetKinds", () => {
  it("warms the pick and the offered defaults only", () => {
    setDefaults({ 7: "nebula" }, { 3: "terrain" });
    setPrefs({ [PREF_KEYS.playerVisualizerCatalog]: turnedOff(["terrain"]) });
    const resolved = probe(() => useVisualizerResolution(3));
    h.warmKind.mockClear();
    probe(() => useWarmSheetKinds(resolved));
    const warmed = h.warmKind.mock.calls.map(([kind]) => kind);
    expect(warmed).toEqual(["nebula", "nebula"]);
    expect(warmed).not.toContain("terrain");
  });
});
