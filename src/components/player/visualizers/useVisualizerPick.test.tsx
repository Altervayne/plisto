// -- Test Imports --
import { beforeEach, describe, expect, it, vi } from "vitest";
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

const h = vi.hoisted(() => ({
  setSetting: vi.fn(() => Promise.resolve()),
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

beforeEach(() => {
  vi.clearAllMocks();
  setGlobal("ridge");
  setDefaults({});
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
