import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PluginVisKindState } from "../../../types";
import { PREF_KEYS, usePreferencesStore } from "../../preferences/store";
import { usePluginsStore } from "../../plugins/store";
import { HANG_LIMIT_MS } from "./netLimits";
import { isKindStopped, reloadVisMarks, resetNetPolicy } from "./netPolicy";
import { SHOWN_BEAT_MS, startStageNets, watchMeters } from "./stageNets";
import {
  HOST,
  KIND,
  READING,
  doc,
  fakeHandle,
  harness,
  kindState,
  mount,
  releaseAll,
  settle,
} from "./stageNetsFixtures";

const h = vi.hoisted(() => ({
  marks: vi.fn((): Promise<PluginVisKindState[]> => Promise.resolve([])),
  mark: vi.fn((_id: string, _kind: string, _mark: string) => Promise.resolve()),
}));

vi.mock("../../../lib/ipc", async (orig) => ({
  ...(await orig<typeof import("../../../lib/ipc")>()),
  pluginVisMarks: h.marks,
  pluginVisMark: h.mark,
}));

beforeEach(async () => {
  doc.visible = true;
  resetNetPolicy();
  usePreferencesStore.setState({ values: {} });
  usePluginsStore.setState({ devMode: false });
  h.marks.mockResolvedValue([]);
  h.mark.mockClear();
  reloadVisMarks();
  await settle();
});

afterEach(() => {
  releaseAll();
  resetNetPolicy();
  vi.useRealTimers();
});

describe("shown-hosts report", () => {
  it("reports on change, re-reports on the beat while mounted, and stops when nothing is mounted", () => {
    const s = harness();
    const nets = startStageNets(s.deps);
    expect(s.deps.report).toHaveBeenCalledWith([]);
    expect(s.deps.every).not.toHaveBeenCalled();
    const release = mount(fakeHandle());
    expect(s.deps.every).toHaveBeenCalledWith(SHOWN_BEAT_MS, expect.any(Function));
    s.tick(0);
    expect(s.deps.report).toHaveBeenLastCalledWith([HOST]);
    s.tick(16);
    expect(s.deps.report).toHaveBeenCalledTimes(2);
    s.beats[0]();
    expect(s.deps.report).toHaveBeenCalledTimes(3);
    expect(s.deps.report).toHaveBeenLastCalledWith([HOST]);
    release();
    expect(s.deps.stopEvery).toHaveBeenCalledTimes(1);
    expect(s.deps.report).toHaveBeenLastCalledWith([]);
    expect(s.deps.report).toHaveBeenCalledTimes(4);
    nets.stop();
  });

  it("leaves a hidden frame out of the report", () => {
    const s = harness();
    const nets = startStageNets(s.deps);
    const handle = fakeHandle();
    handle.live.visible = false;
    mount(handle);
    s.beats[0]();
    expect(s.deps.report).toHaveBeenLastCalledWith([]);
    nets.stop();
  });
});

describe("hang and slow nets", () => {
  it("stops a hung kind for the session with one notice, and ends its frame once faded out", () => {
    const s = harness();
    const nets = startStageNets(s.deps);
    const handle = fakeHandle();
    mount(handle);
    s.run(0, HANG_LIMIT_MS + 200);
    expect(isKindStopped(KIND)).toBe(true);
    expect(s.deps.notice).toHaveBeenCalledTimes(1);
    expect(s.deps.notice).toHaveBeenCalledWith({
      id: "com.example.rings",
      kind: "visualizer_stopped",
      visualizer: KIND,
      cause: "hang",
    });
    expect(handle.ended).toBe(0);
    handle.live.shown = false;
    s.tick(HANG_LIMIT_MS + 300);
    expect(handle.ended).toBe(1);
    expect(h.mark).not.toHaveBeenCalled();
    nets.stop();
  });

  it("reads no hang from a hidden frame", () => {
    const s = harness();
    const nets = startStageNets(s.deps);
    const handle = fakeHandle();
    handle.live.stats = { ...handle.live.stats, visible: false, visibleSince: null };
    mount(handle);
    s.run(0, HANG_LIMIT_MS * 4);
    expect(isKindStopped(KIND)).toBe(false);
    expect(s.deps.notice).not.toHaveBeenCalled();
    nets.stop();
  });
});

describe("flash net", () => {
  it("with the setting off, a tripped meter stops nothing and marks nothing", async () => {
    const s = harness();
    const nets = startStageNets(s.deps);
    const handle = fakeHandle();
    handle.live.flash = READING;
    mount(handle);
    s.run(0, 200);
    await settle();
    expect(handle.ended).toBe(0);
    expect(h.mark).not.toHaveBeenCalled();
    expect(s.deps.notice).not.toHaveBeenCalled();
    expect(s.deps.log).not.toHaveBeenCalled();
    nets.stop();
  });

  it("with the setting on, it cuts the frame, marks the kind and says so once", async () => {
    usePreferencesStore.setState({ values: { [PREF_KEYS.playerVisualizerStopFlashing]: "1" } });
    // The read after the write finds the mark the backend stored.
    h.marks.mockResolvedValue([kindState({ flashing: true })]);
    const s = harness();
    const nets = startStageNets(s.deps);
    const handle = fakeHandle();
    handle.live.flash = READING;
    mount(handle);
    s.run(0, 200);
    await settle();
    expect(handle.ended).toBe(1);
    expect(h.mark).toHaveBeenCalledWith("com.example.rings", "aurora", "flashing");
    expect(s.deps.notice).toHaveBeenCalledTimes(1);
    expect(s.deps.notice).toHaveBeenCalledWith(expect.objectContaining({ cause: "flashing" }));
    expect(isKindStopped(KIND)).toBe(true);
    nets.stop();
  });

  it("in dev mode with the setting off, it logs the reading once and stops nothing", async () => {
    usePluginsStore.setState({ devMode: true });
    const s = harness();
    const nets = startStageNets(s.deps);
    const handle = fakeHandle();
    handle.live.flash = READING;
    mount(handle);
    s.run(0, 200);
    await settle();
    expect(s.deps.log).toHaveBeenCalledTimes(1);
    expect(s.deps.log).toHaveBeenCalledWith(KIND, READING);
    expect(handle.ended).toBe(0);
    expect(h.mark).not.toHaveBeenCalled();
    expect(s.deps.notice).not.toHaveBeenCalled();
    nets.stop();
  });

  it("leaves a kind the user turned back on alone", async () => {
    usePreferencesStore.setState({ values: { [PREF_KEYS.playerVisualizerStopFlashing]: "1" } });
    h.marks.mockResolvedValue([kindState({ turned_back_on: true })]);
    reloadVisMarks();
    await settle();
    const s = harness();
    const nets = startStageNets(s.deps);
    const handle = fakeHandle();
    handle.live.flash = READING;
    mount(handle);
    s.run(0, 200);
    expect(handle.ended).toBe(0);
    expect(h.mark).not.toHaveBeenCalled();
    nets.stop();
  });
});

describe("meter switch", () => {
  it("switches each mounted frame's meter with the setting and dev mode", () => {
    const handle = fakeHandle();
    mount(handle);
    const stop = watchMeters();
    usePreferencesStore.setState({ values: { [PREF_KEYS.playerVisualizerStopFlashing]: "1" } });
    expect(handle.meters[handle.meters.length - 1]).toBe(true);
    usePreferencesStore.setState({ values: {} });
    expect(handle.meters[handle.meters.length - 1]).toBe(false);
    usePluginsStore.setState({ devMode: true });
    expect(handle.meters[handle.meters.length - 1]).toBe(true);
    stop();
    usePluginsStore.setState({ devMode: false });
    expect(handle.meters[handle.meters.length - 1]).toBe(true);
  });

  it("switches a running meter off and on as the setting turns on, so no earlier reading acts", () => {
    usePluginsStore.setState({ devMode: true });
    const handle = fakeHandle();
    mount(handle);
    const stop = watchMeters();
    handle.meters.length = 0;
    usePreferencesStore.setState({ values: { [PREF_KEYS.playerVisualizerStopFlashing]: "1" } });
    expect(handle.meters).toEqual([false, true]);
    stop();
  });
});
