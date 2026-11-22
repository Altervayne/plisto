import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import type { PluginVisKindState } from "../../../types";
import type { PluginKindId } from "../pluginVisualizers";
import { PREF_KEYS, usePreferencesStore } from "../../preferences/store";
import { usePluginsStore } from "../../plugins/store";
import {
  flashAction,
  flashActionNow,
  isKindStopped,
  kindHeld,
  markStops,
  meterWanted,
  reloadVisMarks,
  resetNetPolicy,
  startVisMarks,
  stopForSession,
  useNetPolicy,
  writeVisMark,
} from "./netPolicy";

const h = vi.hoisted(() => ({
  marks: vi.fn((): Promise<PluginVisKindState[]> => Promise.resolve([])),
  mark: vi.fn((_id: string, _kind: string, _mark: string) => Promise.resolve()),
}));

vi.mock("../../../lib/ipc", async (orig) => ({
  ...(await orig<typeof import("../../../lib/ipc")>()),
  pluginVisMarks: h.marks,
  pluginVisMark: h.mark,
}));

const KIND = "com.example.rings/aurora" as PluginKindId;

function state(over: Partial<PluginVisKindState> = {}): PluginVisKindState {
  return {
    id: "com.example.rings",
    kind: "aurora",
    flashing: false,
    graphics_reset: false,
    turned_back_on: false,
    trialed: false,
    ...over,
  };
}

const setStopFlashing = (on: boolean) =>
  usePreferencesStore.setState({ values: on ? { [PREF_KEYS.playerVisualizerStopFlashing]: "1" } : {} });

const settle = async () => {
  for (let i = 0; i < 5; i++) await Promise.resolve();
};

beforeEach(() => {
  resetNetPolicy();
  setStopFlashing(false);
  usePluginsStore.setState({ devMode: false });
  h.marks.mockReset();
  h.marks.mockResolvedValue([]);
  h.mark.mockReset();
  h.mark.mockResolvedValue(undefined);
});

afterEach(() => {
  resetNetPolicy();
  vi.useRealTimers();
});

describe("mark rules", () => {
  it("honors a graphics reset always, and flashing only under the setting unless turned back on", () => {
    expect(markStops(state({ graphics_reset: true }), false)).toBe(true);
    expect(markStops(state({ flashing: true }), false)).toBe(false);
    expect(markStops(state({ flashing: true }), true)).toBe(true);
    expect(markStops(state({ flashing: true, turned_back_on: true }), true)).toBe(false);
    expect(markStops(undefined, true)).toBe(false);
  });

  it("stops on a flash under the setting, logs in dev mode, and leaves a kind turned back on alone", () => {
    expect(flashAction({ stopFlashing: false, devMode: false, turnedBackOn: false })).toBe("ignore");
    expect(flashAction({ stopFlashing: false, devMode: true, turnedBackOn: false })).toBe("log");
    expect(flashAction({ stopFlashing: true, devMode: false, turnedBackOn: false })).toBe("stop");
    expect(flashAction({ stopFlashing: true, devMode: false, turnedBackOn: true })).toBe("ignore");
  });
});

describe("marks across launches", () => {
  it("holds every plugin kind until the first read answers, through failed reads", async () => {
    vi.useFakeTimers();
    h.marks.mockRejectedValue(new Error("busy"));
    reloadVisMarks();
    await settle();
    expect(isKindStopped(KIND)).toBe(true);
    expect(kindHeld(useNetPolicy.getState(), KIND, false)).toBe(true);
    await vi.advanceTimersByTimeAsync(5000);
    expect(h.marks.mock.calls.length).toBeGreaterThan(1);
    expect(isKindStopped(KIND)).toBe(true);
    h.marks.mockResolvedValue([]);
    await vi.advanceTimersByTimeAsync(30_000);
    expect(isKindStopped(KIND)).toBe(false);
  });

  it("honors a stored mark again after a restart, once it is read", async () => {
    h.marks.mockResolvedValue([state({ graphics_reset: true })]);
    const stop = startVisMarks();
    await settle();
    expect(isKindStopped(KIND)).toBe(true);
    stop();

    resetNetPolicy();
    expect(useNetPolicy.getState().marks).toEqual({});
    const again = startVisMarks();
    await settle();
    expect(isKindStopped(KIND)).toBe(true);
    again();
  });

  it("keeps the known marks through a failed read, retrying it", async () => {
    vi.useFakeTimers();
    h.marks.mockResolvedValueOnce([state({ graphics_reset: true })]);
    reloadVisMarks();
    await settle();
    h.marks.mockRejectedValueOnce(new Error("busy"));
    h.marks.mockResolvedValueOnce([state({ graphics_reset: true })]);
    reloadVisMarks();
    await settle();
    expect(isKindStopped(KIND)).toBe(true);
    await vi.advanceTimersByTimeAsync(5000);
    expect(h.marks).toHaveBeenCalledTimes(3);
    expect(isKindStopped(KIND)).toBe(true);
  });

  it("never reads an unanswered read as no marks: a flash stop waits for it", async () => {
    setStopFlashing(true);
    h.marks.mockReturnValue(new Promise(() => {}));
    reloadVisMarks();
    await settle();
    expect(useNetPolicy.getState().loaded).toBe(false);
    expect(flashActionNow(KIND)).toBe("wait");
  });

  it("reads the marks again when the plugin rows change", async () => {
    const stop = startVisMarks();
    await settle();
    usePluginsStore.setState({ rows: [] });
    await settle();
    expect(h.marks).toHaveBeenCalledTimes(2);
    stop();
  });
});

describe("marks written here", () => {
  it("count at once, and stay counted when the write fails", async () => {
    h.mark.mockRejectedValue(new Error("disk"));
    void writeVisMark(KIND, "com.example.rings", "aurora", "graphics_reset");
    expect(isKindStopped(KIND)).toBe(true);
    await settle();
    expect(isKindStopped(KIND)).toBe(true);
    expect(h.marks).not.toHaveBeenCalled();
  });

  it("hand over to the read issued after the write", async () => {
    setStopFlashing(true);
    h.marks.mockResolvedValue([state({ flashing: true })]);
    await writeVisMark(KIND, "com.example.rings", "aurora", "flashing");
    expect(h.mark).toHaveBeenCalledWith("com.example.rings", "aurora", "flashing");
    await settle();
    expect(useNetPolicy.getState().pending).toEqual({});
    expect(isKindStopped(KIND)).toBe(true);
    setStopFlashing(false);
    expect(isKindStopped(KIND)).toBe(false);
  });
});

describe("session stops and the meter", () => {
  it("stops a kind for the session once, writing nothing", () => {
    expect(stopForSession(KIND, "hang")).toBe(true);
    expect(stopForSession(KIND, "slow")).toBe(false);
    expect(isKindStopped(KIND)).toBe(true);
    expect(h.mark).not.toHaveBeenCalled();
  });

  it("runs the meter in dev mode, or under the setting unless the kind was turned back on", async () => {
    expect(meterWanted(KIND)).toBe(false);
    usePluginsStore.setState({ devMode: true });
    expect(meterWanted(KIND)).toBe(true);
    usePluginsStore.setState({ devMode: false });
    setStopFlashing(true);
    expect(meterWanted(KIND)).toBe(true);
    h.marks.mockResolvedValue([state({ turned_back_on: true })]);
    reloadVisMarks();
    await settle();
    expect(meterWanted(KIND)).toBe(false);
  });
});
