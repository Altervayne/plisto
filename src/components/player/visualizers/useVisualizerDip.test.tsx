// -- Test Imports --
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

// -- Unit Imports --
import { useVisualizerDip } from "./useVisualizerDip";

// -- State Imports --
import { applyPluginRows, type PluginKindId } from "../../../state/player/pluginVisualizers";
import { isFrameWanted, reportPhase, useFrameCache } from "../../../state/player/pluginVis/frameCache";
import type { StageSurface } from "../../../state/player/pluginVis/frameCache";
import { GIVE_UP_MS, SLOW_MS, createStageMount } from "../../../state/player/pluginVis/stageMount";
import { visualizerDecl as decl, visualizerRow as visRow } from "../../../state/plugins/fixtures";
import type { DipReason } from "../../../state/player/visualizerDip";
import type { VisualizerKind } from "../../../state/player/visualizerKind";
import type { HostPort } from "../../../state/player/pluginVis/transport";
import type { VisContext } from "../../../visRuntime/protocol";

interface Effect {
  deps: readonly unknown[];
  cleanup: (() => void) | undefined;
}

const h = vi.hoisted(() => ({
  refs: [] as { current: unknown }[],
  refAt: 0,
  effects: [] as (Effect | undefined)[],
  effectAt: 0,
}));

// Refs and effects persist across renders by call order. An effect runs in place when its dependencies
// change, after the cleanup of its last run, as it would after a commit.
vi.mock("react", async (orig) => ({
  ...(await orig<typeof import("react")>()),
  useRef: (init: unknown) => (h.refs[h.refAt++] ??= { current: init }),
  useEffect: (fn: () => void | (() => void), deps: readonly unknown[]) => {
    const at = h.effectAt++;
    const prev = h.effects[at];
    if (prev && deps.every((d, i) => Object.is(d, prev.deps[i]))) return;
    prev?.cleanup?.();
    const cleanup = fn();
    h.effects[at] = { deps, cleanup: typeof cleanup === "function" ? cleanup : undefined };
  },
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

const RINGS = "com.example.rings/aurora-rings" as PluginKindId;
const FRAME_MS = 10;

interface Dip {
  aimed: VisualizerKind;
  ready: boolean;
  reason: DipReason;
  shown: VisualizerKind;
  surface: StageSurface;
}

const clock = { now: 0, reduced: false };
let frames = new Map<number, (now: number) => void>();
let nextRaf = 1;
let opacity: number | null = null;
let swaps: VisualizerKind[] = [];
const stage = { current: { style: { setProperty: (_k: string, v: string) => (opacity = Number(v)) } } };
let dip: Dip;
const onSwap = (kind: VisualizerKind) => {
  swaps.push(kind);
  dip = { ...dip, shown: kind };
};

function unmount() {
  for (const effect of h.effects.splice(0)) effect?.cleanup?.();
}

/** Renders the hook once with the current inputs, as a re-render after a change would. */
function render(next: Partial<Dip> = {}) {
  dip = { ...dip, ...next };
  h.refAt = 0;
  h.effectAt = 0;
  function Probe() {
    useVisualizerDip(stage as never, dip.aimed, dip.ready, dip.reason, dip.shown, onSwap, dip.surface);
    return null;
  }
  renderToStaticMarkup(<Probe />);
}

/** Runs display frames for `ms`, returning the time into the run of each swap. */
function run(ms: number): number[] {
  const at: number[] = [];
  const start = clock.now;
  const end = start + ms;
  while (clock.now < end) {
    clock.now += FRAME_MS;
    const due = [...frames.values()];
    frames = new Map();
    const before = swaps.length;
    for (const cb of due) cb(clock.now);
    if (swaps.length > before) at.push(clock.now - start);
  }
  return at;
}

const looping = () => frames.size > 0;

beforeEach(() => {
  h.refs = [];
  h.effects = [];
  clock.now = 0;
  clock.reduced = false;
  frames = new Map();
  opacity = null;
  swaps = [];
  dip = { aimed: "nebula", ready: true, reason: "manual", shown: "nebula", surface: "player" };
  useFrameCache.setState({ wants: {}, phases: {} });
  applyPluginRows([visRow("com.example.rings", "Rings", [decl()])]);
  vi.stubGlobal("window", { matchMedia: () => ({ matches: clock.reduced }) });
  vi.stubGlobal("requestAnimationFrame", (cb: (now: number) => void) => {
    frames.set(nextRaf, cb);
    return nextRaf++;
  });
  vi.stubGlobal("cancelAnimationFrame", (id: number) => frames.delete(id));
  vi.spyOn(performance, "now").mockImplementation(() => clock.now);
});

afterEach(() => {
  unmount();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.useRealTimers();
});

describe("built-in dips", () => {
  it("swaps a pick at the bottom of a 0.6 s dip and settles at its end", () => {
    render();
    render({ aimed: "bloom" });
    expect(run(310)).toEqual([300]);
    expect(swaps).toEqual(["bloom"]);
    run(280);
    expect(looping()).toBe(true);
    run(20);
    expect(looping()).toBe(false);
    expect(opacity).toBe(1);
  });

  it("takes 1.5 s over a track change", () => {
    render({ reason: "boundary" });
    render({ aimed: "bloom" });
    expect(run(1000)).toEqual([750]);
    run(760);
    expect(looping()).toBe(false);
  });

  it("turns round mid-dip toward a new target without showing the old one", () => {
    render();
    render({ aimed: "bloom" });
    run(150);
    render({ aimed: "lake" });
    expect(run(300).length).toBe(1);
    expect(swaps).toEqual(["lake"]);
  });

  it("swaps at once under a reduced-motion preference", () => {
    clock.reduced = true;
    render();
    render({ aimed: "bloom" });
    expect(run(FRAME_MS)).toEqual([FRAME_MS]);
    expect(opacity).toBe(1);
    expect(looping()).toBe(false);
  });

  it("holds the outgoing kind while the target warms", () => {
    render();
    render({ aimed: "bloom", ready: false });
    run(1000);
    expect(swaps).toEqual([]);
    expect(opacity).toBeNull();
    render({ ready: true });
    expect(run(400)).toEqual([300]);
  });
});

describe("plugin dips", () => {
  it("holds the outgoing kind until the frame draws", () => {
    render();
    render({ aimed: RINGS });
    expect(isFrameWanted("player", RINGS)).toBe(true);
    run(1000);
    expect(swaps).toEqual([]);
    reportPhase("player", RINGS, "ready");
    render();
    expect(run(400)).toEqual([300]);
    expect(swaps).toEqual([RINGS]);
  });

  it("dips to the fallback while slow, then swaps the frame in late", () => {
    render();
    render({ aimed: RINGS });
    reportPhase("player", RINGS, "slow");
    render();
    run(700);
    expect(swaps).toEqual(["ridge"]);
    expect(isFrameWanted("player", RINGS)).toBe(true);
    reportPhase("player", RINGS, "ready");
    render();
    run(700);
    expect(swaps).toEqual(["ridge", RINGS]);
  });

  it("holds on its own surface while the other surface's frame has drawn", () => {
    render({ surface: "ambient" });
    reportPhase("player", RINGS, "ready");
    reportPhase("ambient", RINGS, "mounting");
    render({ aimed: RINGS });
    expect(isFrameWanted("ambient", RINGS)).toBe(true);
    expect(isFrameWanted("player", RINGS)).toBe(false);
    run(1000);
    expect(swaps).toEqual([]);
    reportPhase("ambient", RINGS, "ready");
    render();
    expect(run(400)).toEqual([300]);
  });

  it("releases the frame once nothing aims at it", () => {
    render({ aimed: RINGS });
    expect(isFrameWanted("player", RINGS)).toBe(true);
    render({ aimed: "bloom" });
    expect(isFrameWanted("player", RINGS)).toBe(false);
  });
});

describe("plugin dips on the mount clock", () => {
  const context: VisContext = {
    layout: { width: 100, height: 80, cover: [10, 10, 40, 40], radius: 0, mask: null, floor: null, hush: [] },
    palette: new Float32Array(9),
    cover: null,
    colors: { ground: [0, 0, 0], backing: [0, 0, 0], ink: [1, 1, 1] },
    light: false,
    reactivity: "balanced",
    ambient: false,
    reducedMotion: false,
    settings: {},
  };

  function mounted() {
    const port: HostPort = { postMessage: () => {}, close: () => {}, onmessage: null };
    const mount = createStageMount({
      descriptor: { ...decl(), id: RINGS, kindId: "aurora-rings", settings: [] } as never,
      context: () => context,
      reactivity: () => "balanced",
      onPhase: (phase) => reportPhase("player", RINGS, phase),
      onFail: () => {},
      channel: () => ({ host: port, frame: {} as Transferable }),
    });
    mount.start(() => {});
    reportPhase("player", RINGS, "mounting");
    return { mount, say: (data: unknown) => port.onmessage?.({ data }) };
  }

  beforeEach(() => {
    vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout"] });
  });

  it("falls back at 3 s and swaps in on a ready before 30 s", () => {
    render();
    render({ aimed: RINGS });
    const m = mounted();
    vi.advanceTimersByTime(SLOW_MS - 1);
    render();
    run(700);
    expect(swaps).toEqual([]);
    vi.advanceTimersByTime(1);
    render();
    run(700);
    expect(swaps).toEqual(["ridge"]);
    vi.advanceTimersByTime(5000);
    m.say({ type: "ready", metered: false });
    render();
    run(700);
    expect(swaps).toEqual(["ridge", RINGS]);
  });

  it("gives up at 30 s and keeps the fallback, with the pick still aimed at", () => {
    render();
    render({ aimed: RINGS });
    const m = mounted();
    vi.advanceTimersByTime(GIVE_UP_MS);
    expect(m.mount.phase()).toBe("dropped");
    render();
    run(700);
    expect(swaps).toEqual(["ridge"]);
    expect(dip.aimed).toBe(RINGS);
    m.say({ type: "ready", metered: false });
    render();
    run(700);
    expect(swaps).toEqual(["ridge"]);
  });
});
