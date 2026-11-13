// -- Test Imports --
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// -- Type Imports --
import type { PluginUiEvent } from "../../types";

const { pluginUiAnswer } = vi.hoisted(() => ({ pluginUiAnswer: vi.fn() }));
vi.mock("../../lib/ipc", () => ({ pluginUiAnswer }));

// The emitter keeps module state, so every test loads a fresh copy.
let toasts: typeof import("./pluginToast");
let TOAST_VISIBLE_MS: number;

const toast = (requestId: string, id = "a"): PluginUiEvent => ({
  request_id: requestId,
  id,
  kind: "toast",
  payload: { text: "Hello", action: null },
});

const view = () => toasts.getPluginToast();

beforeEach(async () => {
  vi.useFakeTimers();
  vi.resetModules();
  pluginUiAnswer.mockReset().mockResolvedValue(true);
  toasts = await import("./pluginToast");
  ({ TOAST_VISIBLE_MS } = await import("./uiQueue"));
});

afterEach(() => {
  vi.useRealTimers();
});

describe("plugin toasts", () => {
  it("shows one at a time and answers dismissed after the visible time", () => {
    toasts.pushPluginToast(toast("r1"));
    toasts.pushPluginToast(toast("r2"));
    expect(view()).toMatchObject({ visible: true, toast: { request_id: "r1" } });
    vi.advanceTimersByTime(TOAST_VISIBLE_MS);
    expect(pluginUiAnswer).toHaveBeenCalledWith("r1", { kind: "toast", action: false });
    expect(view()).toMatchObject({ visible: true, toast: { request_id: "r2" } });
    vi.advanceTimersByTime(TOAST_VISIBLE_MS);
    expect(view()).toMatchObject({ visible: false, toast: { request_id: "r2" } });
    expect(pluginUiAnswer).toHaveBeenCalledTimes(2);
  });

  it("close removes a queued toast without answering it", () => {
    toasts.pushPluginToast(toast("r1"));
    toasts.pushPluginToast(toast("r2"));
    toasts.pushPluginToast(toast("r3"));
    toasts.closePluginToast("r2");
    vi.advanceTimersByTime(TOAST_VISIBLE_MS);
    expect(view()).toMatchObject({ toast: { request_id: "r3" } });
    expect(pluginUiAnswer.mock.calls.map((c) => c[0])).toEqual(["r1"]);
  });

  it("closing the shown toast restarts the timer for the next", () => {
    toasts.pushPluginToast(toast("r1"));
    toasts.pushPluginToast(toast("r2"));
    vi.advanceTimersByTime(3000);
    toasts.closePluginToast("r1");
    vi.advanceTimersByTime(TOAST_VISIBLE_MS - 1);
    expect(pluginUiAnswer).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(pluginUiAnswer).toHaveBeenCalledWith("r2", { kind: "toast", action: false });
  });

  it("answers an action once and ignores a late second answer", () => {
    toasts.pushPluginToast(toast("r1"));
    toasts.answerPluginToast("r1", true);
    toasts.answerPluginToast("r1", false);
    vi.advanceTimersByTime(TOAST_VISIBLE_MS);
    expect(pluginUiAnswer.mock.calls).toEqual([["r1", { kind: "toast", action: true }]]);
  });

  it("swallows a failed answer", async () => {
    pluginUiAnswer.mockRejectedValue(new Error("gone"));
    toasts.pushPluginToast(toast("r1"));
    toasts.answerPluginToast("r1", true);
    await vi.advanceTimersByTimeAsync(0);
    expect(view()).toMatchObject({ visible: false });
  });

  it("drops the toasts of plugins that left the live set", () => {
    toasts.pushPluginToast(toast("r1", "a"));
    toasts.pushPluginToast(toast("r2", "b"));
    toasts.dropPluginToasts(new Set(["b"]));
    expect(view()).toMatchObject({ visible: true, toast: { request_id: "r2" } });
    expect(pluginUiAnswer).not.toHaveBeenCalled();
  });
});
