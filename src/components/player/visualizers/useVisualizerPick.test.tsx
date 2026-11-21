// -- Test Imports --
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

// -- Unit Imports --
import { useVisualizerPick } from "./useVisualizerPick";
import { useVisualizerResolution } from "./useVisualizerResolution";
import { useWarmCurrentVisualizer } from "./useWarmVisualizers";

// -- State Imports --
import { PREF_KEYS, usePreferencesStore } from "../../../state/preferences/store";
import { useVisualizerDefaults } from "../../../state/player/visualizerDefaults";
import { ALL_OFFERED, nextOfferedKind } from "../../../state/player/visualizerCatalog";
import type { VisualizerKind } from "../../../state/player/visualizerKind";
import type { VisualizerOverride } from "../../../state/player/visualizerResolve";
import { usePluginsStore } from "../../../state/plugins/store";
import { reloadPlugins, startPluginsSync } from "../../../state/plugins/usePluginsSync";
import { visualizerDecl as decl, visualizerRow as visRow } from "../../../state/plugins/fixtures";

const h = vi.hoisted(() => ({
  setSetting: vi.fn(() => Promise.resolve()),
  setAlbumVisualizer: vi.fn(() => Promise.resolve()),
  pluginsList: vi.fn(),
  warmKind: vi.fn(),
  trackId: 3,
}));

// Effects run in place, so a static render exercises them.
vi.mock("react", async (orig) => ({
  ...(await orig<typeof import("react")>()),
  useEffect: (fn: () => void) => void fn(),
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
  setSetting: h.setSetting,
  setAlbumVisualizer: h.setAlbumVisualizer,
  pluginsList: h.pluginsList,
  pluginsBootState: () => Promise.resolve({ runtime: "running", unclean: false, safe_flag: false }),
  pluginsDevMode: () => Promise.resolve(false),
}));
// One attempt per read, so a failed plugins read lands at once.
vi.mock("../../../lib/withRetry", () => ({ withRetry: (fn: () => Promise<unknown>) => fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen: () => Promise.resolve(() => {}) }));
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
const FILE_FROM_DISK = -2;
const OVERRIDE: VisualizerOverride = { kind: "bloom", albumKey: "album:7" };

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

function setGlobal(kind: VisualizerKind): void {
  usePreferencesStore.setState({
    values: { [PREF_KEYS.playerVisualizer]: kind, [PREF_KEYS.visualizerWarningAck]: "1" },
    failedKeys: new Set<string>(),
    loaded: true,
  });
}

function setDefaults(albums: Record<number, string>, override: VisualizerOverride | null = null): void {
  useVisualizerDefaults.setState({ status: "ready", albums, tracks: {}, override });
}

const globalPick = () => usePreferencesStore.getState().values[PREF_KEYS.playerVisualizer];
const override = () => useVisualizerDefaults.getState().override;
const pickOn = (trackId: number, kind: VisualizerKind) => probe(() => useVisualizerPick(trackId))(kind);
const drawn = (trackId = 3) => probe(() => useVisualizerResolution(trackId)).resolution.picked;

let stopSync: (() => void) | null = null;

beforeEach(() => {
  vi.clearAllMocks();
  setGlobal("ridge");
  setDefaults({});
  usePluginsStore.setState({ rows: [], boot: null, status: "idle", listed: false, epoch: 0 });
});

afterEach(() => {
  stopSync?.();
  stopSync = null;
});

describe("useVisualizerPick of Off", () => {
  it("writes the global pick Off and drops the override over a default", () => {
    setDefaults({ 7: "nebula" }, OVERRIDE);
    expect(pickOn(3, "off")).toEqual({ override: null, global: "off" });
    expect(globalPick()).toBe("off");
    expect(override()).toBeNull();
    expect(useVisualizerDefaults.getState().albums).toEqual({ 7: "nebula" });
    expect(drawn()).toBe("off");
  });

  it("writes the global pick Off with no default", () => {
    pickOn(3, "off");
    expect(globalPick()).toBe("off");
    expect(override()).toBeNull();
  });

  it("writes the global pick Off for a file opened from disk", () => {
    pickOn(FILE_FROM_DISK, "off");
    expect(globalPick()).toBe("off");
    expect(drawn(FILE_FROM_DISK)).toBe("off");
  });
});

describe("useVisualizerPick while the global pick is Off", () => {
  it("lifts Off and sets the kind aside over a default that differs", () => {
    setGlobal("off");
    setDefaults({ 7: "nebula" });
    pickOn(3, "glass");
    expect(globalPick()).toBe("glass");
    expect(override()).toEqual({ kind: "glass", albumKey: "album:7" });
    expect(drawn()).toBe("glass");
  });

  it("lifts Off to the default with no override", () => {
    setGlobal("off");
    setDefaults({ 7: "nebula" });
    pickOn(3, "nebula");
    expect(globalPick()).toBe("nebula");
    expect(override()).toBeNull();
    expect(drawn()).toBe("nebula");
  });

  it("does not bring back the override dropped by Off", () => {
    setDefaults({ 7: "nebula" }, OVERRIDE);
    pickOn(3, "off");
    pickOn(3, "nebula");
    expect(override()).toBeNull();
    expect(drawn()).toBe("nebula");
  });

  it("lifts Off for a file opened from disk", () => {
    setGlobal("off");
    pickOn(FILE_FROM_DISK, "glass");
    expect(globalPick()).toBe("glass");
    expect(override()).toBeNull();
    expect(drawn(FILE_FROM_DISK)).toBe("glass");
  });
});

describe("the V cycle over a default", () => {
  // The ambient stage's cycle: the next offered kind after the drawn one, picked by hand.
  const cycle = () => {
    const next = nextOfferedKind(ALL_OFFERED, drawn()) as VisualizerKind;
    pickOn(3, next);
    return next;
  };

  it("reaches Off as the global pick, then lifts it to the first kind", () => {
    setDefaults({ 7: "nebula" });
    let steps = 0;
    while (cycle() !== "off") steps += 1;
    expect(steps).toBeLessThan(ALL_OFFERED.offeredKinds.length + 1);
    expect(globalPick()).toBe("off");
    expect(override()).toBeNull();
    expect(drawn()).toBe("off");

    const first = cycle();
    expect(first).toBe(nextOfferedKind(ALL_OFFERED, "off"));
    expect(globalPick()).toBe(first);
    expect(override()).toEqual({ kind: first, albumKey: "album:7" });
    expect(drawn()).toBe(first);
  });
});

describe("useWarmCurrentVisualizer while the global pick is Off", () => {
  it("warms Off, not the default it holds", () => {
    setGlobal("off");
    setDefaults({ 7: "nebula" }, OVERRIDE);
    probe(useWarmCurrentVisualizer);
    expect(h.warmKind.mock.calls).toEqual([["off"]]);
  });
});

const AURORA = "com.example.vis/aurora-rings";
const RINGS = "com.example.vis/rings";
const EXAMPLE = visRow("com.example.vis", "Example", [decl({ aliases: ["rings"] })]);

/** Every stored visualizer value, as one string to compare byte for byte. */
const stored = () => {
  const { albums, tracks } = useVisualizerDefaults.getState();
  return JSON.stringify([usePreferencesStore.getState().values, albums, tracks]);
};

describe("a stored plugin kind before the plugins list arrives", () => {
  const failRead = () => h.pluginsList.mockRejectedValue(new Error("backend not ready"));
  const startSync = async () => {
    stopSync = startPluginsSync();
    await vi.waitFor(() => expect(usePluginsStore.getState().status).not.toBe("loading"));
  };

  it("is never written back through a failed read, a retry and a late success", async () => {
    setGlobal(AURORA);
    setDefaults({ 7: AURORA });
    const before = stored();
    failRead();
    await startSync();
    expect(usePluginsStore.getState().status).toBe("failed");
    expect(drawn()).toBe(AURORA);
    expect(stored()).toBe(before);

    expect(await reloadPlugins()).toBe(false);
    expect(drawn()).toBe(AURORA);
    expect(stored()).toBe(before);

    h.pluginsList.mockResolvedValue([EXAMPLE]);
    expect(await reloadPlugins()).toBe(true);
    expect(drawn()).toBe(AURORA);
    expect(stored()).toBe(before);
    expect(h.setSetting).not.toHaveBeenCalled();
    expect(h.setAlbumVisualizer).not.toHaveBeenCalled();
  });

  it("falls back on screen only once a listing lacks the plugin", async () => {
    setGlobal(AURORA);
    const before = stored();
    failRead();
    await startSync();
    h.pluginsList.mockResolvedValue([]);
    expect(await reloadPlugins()).toBe(true);
    expect(drawn()).toBe("ridge");
    expect(stored()).toBe(before);
    expect(h.setSetting).not.toHaveBeenCalled();
  });

  it("sets a pick aside over a pending default instead of replacing the global pick", () => {
    setDefaults({ 7: AURORA });
    pickOn(3, "nebula");
    expect(globalPick()).toBe("ridge");
    expect(override()).toEqual({ kind: "nebula", albumKey: "album:7" });
    expect(useVisualizerDefaults.getState().albums).toEqual({ 7: AURORA });
  });
});

describe("a kind stored under an alias", () => {
  beforeEach(() => usePluginsStore.getState().applyRows([EXAMPLE]));

  it("reads as its current kind and is not rewritten on read", () => {
    setGlobal(RINGS);
    setDefaults({ 7: RINGS });
    const before = stored();
    expect(drawn()).toBe(AURORA);
    expect(probe(() => useVisualizerResolution(3)).resolution.defaultKind).toBe(AURORA);
    expect(stored()).toBe(before);
    expect(h.setSetting).not.toHaveBeenCalled();
  });

  it("is rewritten by the next write of the pick", () => {
    setGlobal(RINGS);
    pickOn(3, RINGS);
    expect(globalPick()).toBe(AURORA);
    expect(h.setSetting).toHaveBeenCalledWith(PREF_KEYS.playerVisualizer, AURORA);
  });

  it("stays as stored on an album default until that default is written", async () => {
    setDefaults({ 7: RINGS });
    expect(pickOn(3, AURORA)).toEqual({ override: null, global: null });
    expect(useVisualizerDefaults.getState().albums).toEqual({ 7: RINGS });

    const { picked } = probe(() => useVisualizerResolution(3)).resolution;
    expect(await useVisualizerDefaults.getState().setAlbumDefault(7, picked)).toBe(true);
    expect(useVisualizerDefaults.getState().albums).toEqual({ 7: AURORA });
    expect(h.setAlbumVisualizer).toHaveBeenCalledWith(7, AURORA);
  });
});

describe("safe mode and a held runtime", () => {
  it.each(["safe", "held"] as const)("keep a stored plugin pick and default in a %s runtime", (runtime) => {
    usePluginsStore.getState().applyRows([EXAMPLE]);
    usePluginsStore.getState().applyBoot({ runtime, unclean: true, safe_flag: runtime === "safe" });
    setGlobal(AURORA);
    setDefaults({ 7: AURORA });
    const before = stored();
    expect(drawn()).toBe(AURORA);
    expect(pickOn(3, AURORA)).toEqual({ override: null, global: null });
    expect(stored()).toBe(before);
    expect(h.setSetting).not.toHaveBeenCalled();
  });
});
