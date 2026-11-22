import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { BAND_COUNT, type LevelFrame } from "../../../types";
import { createStageMount } from "./stageMount";
import { watchStages } from "./frameCache";
import { feedTapOf } from "./feedTap";
import { createWaveHub } from "./waveform";

import type { HostMessage, Tick, VisContext, VisInit } from "../../../visRuntime/protocol";
import type { PluginVisualizerDescriptor } from "../pluginVisualizers";
import type { FeedSources } from "./feed";
import type { HostPort } from "./transport";

const DESCRIPTOR = {
  id: "com.example.rings/aurora",
  pluginId: "com.example.rings",
  kindId: "aurora",
  look: { light: { composite: "ink" }, dark: { composite: "light" } },
  needs: { fine: false, cover: false, pointer: false, waveform: false },
  fillsStage: false,
  settings: [],
} as unknown as PluginVisualizerDescriptor;

const CONTEXT: VisContext = {
  layout: { width: 100, height: 80, cover: [0, 0, 1, 1], radius: 0, mask: null, floor: null, hush: [] },
  palette: new Float32Array(9),
  cover: null,
  colors: { ground: [0, 0, 0], backing: [0, 0, 0], ink: [1, 1, 1] },
  light: false,
  reactivity: "balanced",
  ambient: false,
  reducedMotion: false,
  settings: {},
};

function setup(pageChannel?: () => boolean) {
  const posted: HostMessage[] = [];
  const port: HostPort = { postMessage: (m) => posted.push(m), close: vi.fn(), onmessage: null };
  const sources: FeedSources = {
    bands: () => new Array(BAND_COUNT).fill(0),
    level: () => ({ rms: 0, peak: 0, flux: 0 }) as LevelFrame,
    fine: () => null,
    status: () => ({ playing: true, track_id: 1, start_seq: 1, position_secs: 0, duration_secs: 60 }),
    pointer: () => null,
    acquireFine: () => () => {},
    waves: createWaveHub({ setEmit: () => Promise.resolve(), follow: () => () => {} }),
  };
  const mount = createStageMount({
    descriptor: DESCRIPTOR,
    context: () => CONTEXT,
    reactivity: () => "balanced",
    onPhase: () => {},
    onFail: () => {},
    sources,
    channel: () => ({ host: port, frame: {} as Transferable }),
    pageChannel,
  });
  let init: VisInit | null = null;
  const start = () => mount.start((message) => (init = message));
  return { mount, start, init: () => init, posted, port };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

describe("the init's channel flag", () => {
  it("is set when the plugin has a page or background frame", () => {
    const s = setup(() => true);
    s.start();
    expect(s.init()?.channel).toBe(true);
  });

  it("is clear for a plugin with no page", () => {
    const s = setup(() => false);
    s.start();
    expect(s.init()?.channel).toBe(false);
  });

  it("is read from the plugin store by default, and a plugin with no row has none", () => {
    const s = setup();
    s.start();
    expect(s.init()?.channel).toBe(false);
  });
});

describe("the mount's feed tap", () => {
  it("sees each tick as it is sent, and none once released", () => {
    const s = setup(() => false);
    s.start();
    s.mount.setInputs({ opacity: 1, mounting: false, intersecting: true, documentVisible: true });
    const tap = feedTapOf(s.mount.stats);
    expect(tap).not.toBeNull();
    const seen: Tick[] = [];
    const release = tap!((tick) => seen.push(tick));
    s.mount.step(0);
    s.mount.step(16);
    const sent = s.posted.filter((m) => m.type === "tick");
    expect(seen).toHaveLength(sent.length);
    expect(seen.length).toBeGreaterThan(0);
    release();
    s.mount.step(32);
    expect(seen.length).toBe(sent.length);
  });
});

describe("the metered mark", () => {
  it("tells the stage watchers on each change of whether the frame is metered, and no other time", () => {
    const s = setup(() => false);
    s.start();
    let told = 0;
    const stop = watchStages(() => void (told += 1));
    s.port.onmessage?.({ data: { type: "ready", metered: false } });
    expect(told).toBe(1);
    expect(s.mount.metered()).toBe(false);
    s.port.onmessage?.({ data: { type: "metered" } });
    expect(told).toBe(2);
    expect(s.mount.metered()).toBe(true);
    s.port.onmessage?.({ data: { type: "metered" } });
    expect(told).toBe(2);
    stop();
  });
});
