import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PluginVisKindState } from "../../../types";
import { usePreferencesStore } from "../../preferences/store";
import { usePluginsStore } from "../../plugins/store";
import { wantFrame } from "./frameCache";
import { reloadVisMarks, resetNetPolicy } from "./netPolicy";
import { layReset, startStageNets } from "./stageNets";
import { TRIAL_MS, createResetSentinel } from "./useResetSentinel";
import {
  AURORA_RESET,
  HALO,
  HALO_RESET,
  KIND,
  doc,
  fakeHandle,
  harness,
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

describe("graphics reset", () => {
  it("cuts a shown frame of a kind that reset the graphics", () => {
    const s = harness();
    const nets = startStageNets(s.deps);
    const handle = fakeHandle();
    mount(handle);
    s.tick(0);
    layReset([AURORA_RESET], s.deps.notice);
    s.tick(16);
    expect(handle.ended).toBe(1);
    expect(h.mark).toHaveBeenCalledWith("com.example.rings", "aurora", "graphics_reset");
    expect(s.deps.notice).toHaveBeenCalledWith(expect.objectContaining({ cause: "graphics_reset" }));
    nets.stop();
  });

  it("marks every kind in its trial and says so once, naming the kind on the stage", () => {
    const notice = vi.fn();
    const aurora = fakeHandle();
    aurora.live.shown = false;
    mount(aurora);
    mount(fakeHandle(HALO));
    layReset([AURORA_RESET, HALO_RESET], notice);
    expect(h.mark).toHaveBeenCalledWith("com.example.rings", "aurora", "graphics_reset");
    expect(h.mark).toHaveBeenCalledWith("com.example.rings", "halo", "graphics_reset");
    expect(notice).toHaveBeenCalledTimes(1);
    expect(notice).toHaveBeenCalledWith(expect.objectContaining({ visualizer: HALO }));
  });

  it("names the first kind when none of them is on the stage", () => {
    const notice = vi.fn();
    layReset([AURORA_RESET, HALO_RESET], notice);
    expect(notice).toHaveBeenCalledTimes(1);
    expect(notice).toHaveBeenCalledWith(expect.objectContaining({ visualizer: KIND }));
  });

  it("hands the sentinel the kinds on the stage, and whether each has drawn", () => {
    const s = harness();
    const nets = startStageNets(s.deps);
    const handle = fakeHandle();
    handle.live.phase = "mounting";
    mount(handle);
    expect(s.deps.onKinds).toHaveBeenLastCalledWith([{ ...AURORA_RESET, ready: false }]);
    handle.live.phase = "ready";
    s.tick(0);
    expect(s.deps.onKinds).toHaveBeenLastCalledWith([{ ...AURORA_RESET, ready: true }]);
    handle.live.phase = "dropped";
    s.tick(16);
    expect(s.deps.onKinds).toHaveBeenLastCalledWith([]);
    nets.stop();
  });
});

describe("graphics-reset trials", () => {
  function trialHarness() {
    const s = harness();
    const begin = vi.fn((_id: string, _kind: string) => Promise.resolve(true));
    const end = vi.fn((_id: string, _kind: string, _passed: boolean) => Promise.resolve());
    const sentinel = createResetSentinel({ begin, end, onLoss: vi.fn(), target: () => null });
    s.deps.onKinds = (kinds) => sentinel.set(kinds);
    return { ...s, begin, end };
  }

  it("never passes a trial for a preview that left, however long its frame is kept", async () => {
    vi.useFakeTimers();
    const s = trialHarness();
    const nets = startStageNets(s.deps);
    const handle = fakeHandle();
    handle.live.shown = false;
    handle.live.phase = "mounting";
    const unwant = wantFrame("player", KIND);
    mount(handle);
    await settle();
    expect(s.begin).toHaveBeenCalledWith("com.example.rings", "aurora");
    handle.live.phase = "ready";
    s.tick(0);
    vi.advanceTimersByTime(1000);
    unwant();
    s.tick(1000);
    expect(s.end).toHaveBeenCalledWith("com.example.rings", "aurora", false);
    vi.advanceTimersByTime(TRIAL_MS * 2);
    s.tick(TRIAL_MS * 2);
    expect(s.end).toHaveBeenCalledTimes(1);
    expect(s.begin).toHaveBeenCalledTimes(1);
    nets.stop();
  });

  it("starts the pass clock once the frame drew", async () => {
    vi.useFakeTimers();
    const s = trialHarness();
    const nets = startStageNets(s.deps);
    const handle = fakeHandle();
    handle.live.phase = "mounting";
    mount(handle);
    await settle();
    vi.advanceTimersByTime(TRIAL_MS);
    expect(s.end).not.toHaveBeenCalled();
    handle.live.phase = "ready";
    s.tick(0);
    vi.advanceTimersByTime(TRIAL_MS);
    expect(s.end).toHaveBeenCalledWith("com.example.rings", "aurora", true);
    nets.stop();
  });

  it("ends the trial unpassed when the document hides", async () => {
    vi.useFakeTimers();
    const s = trialHarness();
    const nets = startStageNets(s.deps);
    mount(fakeHandle());
    await settle();
    vi.advanceTimersByTime(TRIAL_MS / 2);
    doc.visible = false;
    nets.sample();
    expect(s.end).toHaveBeenCalledWith("com.example.rings", "aurora", false);
    vi.advanceTimersByTime(TRIAL_MS);
    expect(s.end).toHaveBeenCalledTimes(1);
    nets.stop();
  });
});
