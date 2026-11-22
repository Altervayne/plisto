import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { BAND_COUNT, type LevelFrame } from "../../../types";
import type { HostMessage, VisContext, VisInit } from "../../../visRuntime/protocol";
import type { PluginVisualizerDescriptor } from "../pluginVisualizers";
import type { PluginVisualizerNeeds } from "../../plugins/visualizerDecl";
import { createWaveHub } from "./waveform";
import type { FeedSources } from "./feed";
import type { HostPort } from "./transport";
import { GIVE_UP_MS, SLOW_MS, createStageMount, type StagePhase } from "./stageMount";

const NO_NEEDS: PluginVisualizerNeeds = { fine: false, cover: false, pointer: false, waveform: false };

function descriptor(needs: PluginVisualizerNeeds = NO_NEEDS): PluginVisualizerDescriptor {
  return {
    id: "com.example.rings/aurora",
    pluginId: "com.example.rings",
    kindId: "aurora",
    family: "plugin:com.example.rings",
    pluginName: "Rings",
    name: "Aurora",
    look: { light: { composite: "ink", blend: "multiply" }, dark: { composite: "light", blend: "screen" } },
    needs,
    fillsStage: false,
    darkOnly: false,
    settings: [
      { id: "shape", label: "Shape", type: "choice", options: [{ id: "a", label: "A" }], default: "a" },
      { id: "glow", label: "Glow", type: "toggle", default: true },
    ],
    presets: [],
    aliases: [],
    version: "1.0.0",
    manifestHash: "abc",
  } as PluginVisualizerDescriptor;
}

const CONTEXT: VisContext = {
  layout: { width: 100, height: 80, cover: [10, 10, 40, 40], radius: 8, mask: null, floor: null, hush: [] },
  palette: new Float32Array(9),
  cover: null,
  colors: { ground: [0, 0, 0], backing: [0, 0, 0], ink: [1, 1, 1] },
  light: false,
  reactivity: "balanced",
  ambient: false,
  reducedMotion: false,
  settings: { shape: "a", glow: true },
};

function setup(needs: PluginVisualizerNeeds = NO_NEEDS, meter?: () => boolean) {
  const posted: HostMessage[] = [];
  const port: HostPort = { postMessage: (m) => posted.push(m), close: vi.fn(), onmessage: null };
  const phases: StagePhase[] = [];
  const onFail = vi.fn();
  const releaseFine = vi.fn();
  const setEmit = vi.fn((_on: boolean) => Promise.resolve());
  const sources: FeedSources = {
    bands: () => new Array(BAND_COUNT).fill(0),
    level: () => ({ rms: 0, peak: 0, flux: 0 }) as LevelFrame,
    fine: () => [0.1],
    status: () => ({ playing: true, track_id: 1, start_seq: 1, position_secs: 0, duration_secs: 60 }),
    pointer: () => null,
    acquireFine: vi.fn(() => releaseFine),
    waves: createWaveHub({ setEmit, follow: () => () => {} }),
  };
  const view = { context: CONTEXT };
  const mount = createStageMount({
    descriptor: descriptor(needs),
    context: () => view.context,
    reactivity: () => "balanced",
    onPhase: (p) => phases.push(p),
    onFail,
    pointer: () => ({ x: 0.5, y: 0.25, inside: true }),
    sources,
    channel: () => ({ host: port, frame: {} as Transferable }),
    meter,
  });
  let init: VisInit | null = null;
  const start = () => mount.start((message) => (init = message));
  const say = (data: unknown) => port.onmessage?.({ data });
  const ticks = () => posted.filter((m): m is Extract<HostMessage, { type: "tick" }> => m.type === "tick");
  const sent = { posted, port, phases, onFail, sources, releaseFine, setEmit };
  return { view, mount, ...sent, start, say, ticks, init: () => init };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("stage mount lifecycle", () => {
  it("posts init for the kind with its setting shapes and defaults, unmetered", () => {
    const s = setup();
    s.start();
    const init = s.init()!;
    expect(init.kind).toBe("aurora");
    expect(init.meter).toBe(false);
    expect(init.composite).toEqual({ light: "ink", dark: "light" });
    expect(init.settingShapes).toEqual([
      { id: "shape", type: "choice", options: ["a"] },
      { id: "glow", type: "toggle" },
    ]);
    expect(init.context).toBe(CONTEXT);
  });

  it("holds in mounting until the frame says ready", () => {
    const s = setup();
    s.start();
    vi.advanceTimersByTime(SLOW_MS - 1);
    expect(s.mount.phase()).toBe("mounting");
    s.say({ type: "ready", metered: false });
    expect(s.mount.phase()).toBe("ready");
    vi.advanceTimersByTime(GIVE_UP_MS);
    expect(s.phases).toEqual(["ready"]);
  });

  it("turns slow at the slow mark and still swaps in on a late ready", () => {
    const s = setup();
    s.start();
    vi.advanceTimersByTime(SLOW_MS);
    expect(s.mount.phase()).toBe("slow");
    vi.advanceTimersByTime(2000);
    s.say({ type: "ready", metered: false });
    vi.advanceTimersByTime(GIVE_UP_MS);
    expect(s.phases).toEqual(["slow", "ready"]);
    expect(s.onFail).not.toHaveBeenCalled();
  });

  it("gives up at the limit with no fault, disposing the frame's port", () => {
    const s = setup();
    s.start();
    vi.advanceTimersByTime(GIVE_UP_MS);
    expect(s.phases).toEqual(["slow", "dropped"]);
    expect(s.onFail).not.toHaveBeenCalled();
    expect(s.posted[s.posted.length - 1]).toEqual({ type: "dispose" });
    expect(s.port.close).toHaveBeenCalled();
    s.say({ type: "ready", metered: false });
    expect(s.mount.phase()).toBe("dropped");
  });

  it("fails on an error or a lost context", () => {
    const s = setup();
    s.start();
    s.say({ type: "error", stage: "compile", message: "bad shader" });
    expect(s.phases).toEqual(["failed"]);
    expect(s.onFail).toHaveBeenCalledTimes(1);
    s.say({ type: "lost" });
    expect(s.onFail).toHaveBeenCalledTimes(1);
  });
});

describe("stage mount ticking", () => {
  it("ticks while compiling under the dip at opacity 0, and not while off screen", () => {
    const s = setup();
    s.start();
    s.mount.setInputs({ opacity: 0 });
    s.mount.step(16);
    expect(s.ticks()).toHaveLength(0);
    s.mount.setInputs({ intersecting: true });
    s.mount.step(32);
    expect(s.ticks()).toHaveLength(1);
  });

  it("stops ticking a drawn frame that is faded out", () => {
    const s = setup();
    s.start();
    s.mount.setInputs({ intersecting: true, opacity: 0 });
    s.say({ type: "ready", metered: false });
    s.mount.step(16);
    expect(s.ticks()).toHaveLength(0);
    s.mount.setInputs({ opacity: 1 });
    s.mount.step(32);
    expect(s.ticks()).toHaveLength(1);
  });

  it("hands the stage pointer only to a kind that asks for it", () => {
    const plain = setup();
    plain.start();
    plain.mount.setInputs({ intersecting: true });
    plain.mount.step(16);
    expect(plain.ticks()[0].pointer).toBeNull();

    const pointed = setup({ ...NO_NEEDS, pointer: true });
    pointed.start();
    pointed.mount.setInputs({ intersecting: true });
    pointed.mount.step(16);
    expect(pointed.ticks()[0].pointer).toEqual({ x: 0.5, y: 0.25, inside: true });
  });

  it("releases the fine and wave holds on dispose", () => {
    const s = setup({ ...NO_NEEDS, fine: true, waveform: true });
    s.start();
    s.mount.setInputs({ intersecting: true });
    expect(s.sources.acquireFine).toHaveBeenCalledTimes(1);
    expect(s.setEmit).toHaveBeenLastCalledWith(true);
    s.mount.dispose();
    expect(s.releaseFine).toHaveBeenCalledTimes(1);
    expect(s.setEmit).toHaveBeenLastCalledWith(false);
    expect(s.posted[s.posted.length - 1]).toEqual({ type: "dispose" });
  });

  it("releases the holds when it gives up", () => {
    const s = setup({ ...NO_NEEDS, fine: true });
    s.start();
    s.mount.setInputs({ intersecting: true });
    vi.advanceTimersByTime(GIVE_UP_MS);
    expect(s.releaseFine).toHaveBeenCalledTimes(1);
  });

  it("sends only the context fields that changed", () => {
    const s = setup();
    s.start();
    s.mount.sync();
    s.view.context = { ...CONTEXT, light: true };
    s.mount.sync();
    const updates = s.posted.filter((m) => m.type === "update");
    expect(updates).toEqual([{ type: "update", context: { light: true } }]);
  });
});

const READING = { flashesPerSec: 6, redFlashesPerSec: 0, area: 0.4 };

describe("stage mount meter", () => {
  it("starts the meter at init when it is wanted then", () => {
    const s = setup(NO_NEEDS, () => true);
    s.start();
    expect(s.init()!.meter).toBe(true);
  });

  it("switches the meter of a started frame only on a change", () => {
    const s = setup();
    s.mount.setMeter(true);
    s.start();
    expect(s.init()!.meter).toBe(false);
    s.mount.setMeter(false);
    s.mount.setMeter(true);
    s.mount.setMeter(true);
    s.mount.setMeter(false);
    expect(s.posted.filter((m) => m.type === "meter")).toEqual([
      { type: "meter", on: true },
      { type: "meter", on: false },
    ]);
  });

  it("records whether the frame is metered, from ready or a late message", () => {
    const s = setup();
    s.start();
    expect(s.mount.metered()).toBeNull();
    s.say({ type: "ready", metered: false });
    expect(s.mount.metered()).toBe(false);
    s.say({ type: "metered" });
    expect(s.mount.metered()).toBe(true);
  });

  it("keeps the reading the meter tripped with", () => {
    const s = setup(NO_NEEDS, () => true);
    s.start();
    const reading = { flashesPerSec: 5, redFlashesPerSec: 1, area: 0.3 };
    s.say({ type: "flash", reading });
    s.say({ type: "flash", reading: { ...reading, flashesPerSec: 9 } });
    expect(s.mount.flash()).toEqual(reading);
  });

  it("drops the reading on a switch, and takes none sent before the frame got the switch", () => {
    const s = setup(NO_NEEDS, () => true);
    s.start();
    s.mount.setInputs({ intersecting: true });
    s.say({ type: "ready", metered: true });
    s.say({ type: "flash", reading: READING });
    expect(s.mount.flash()).toEqual(READING);
    s.mount.setMeter(false);
    expect(s.mount.flash()).toBeNull();
    s.say({ type: "flash", reading: READING });
    expect(s.mount.flash()).toBeNull();
    s.mount.setMeter(true);
    s.say({ type: "flash", reading: READING });
    expect(s.mount.flash()).toBeNull();
    s.mount.step(16);
    const [tick] = s.ticks();
    s.say({ type: "ack", seq: tick.seq, ms: 2 });
    s.say({ type: "flash", reading: READING });
    expect(s.mount.flash()).toEqual(READING);
  });

  it("withholds ticks while held, with the slot still visible", () => {
    const s = setup();
    s.start();
    s.mount.setInputs({ intersecting: true });
    s.say({ type: "ready", metered: false });
    s.mount.hold(true);
    s.mount.step(16);
    expect(s.ticks()).toHaveLength(0);
    expect(s.mount.visible()).toBe(true);
    s.mount.hold(false);
    s.mount.step(32);
    expect(s.ticks()).toHaveLength(1);
  });
});
