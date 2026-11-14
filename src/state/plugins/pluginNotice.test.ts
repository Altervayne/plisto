// -- Test Imports --
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// -- Unit Imports --
import {
  PLUGINS_NOTICE,
  currentPluginNotice,
  dismissPluginNotice,
  resetPluginNotice,
  showPluginNotice,
  startPluginNoticeListener,
} from "./pluginNotice";
import { TOAST_VISIBLE_MS } from "./uiQueue";

// -- Type Imports --
import type { PluginNotice } from "../../types";

const { listen } = vi.hoisted(() => ({ listen: vi.fn() }));
vi.mock("@tauri-apps/api/event", () => ({ listen }));

const tap: PluginNotice = { id: "tap", kind: "auto_disabled" };
let onNotice: (event: { payload: PluginNotice }) => void;
let stop: () => void;

beforeEach(async () => {
  vi.useFakeTimers();
  resetPluginNotice();
  listen.mockReset().mockImplementation(async (name: string, cb: unknown) => {
    expect(name).toBe(PLUGINS_NOTICE);
    onNotice = cb as typeof onNotice;
    return () => {};
  });
  stop = startPluginNoticeListener();
  await vi.advanceTimersByTimeAsync(0);
});

afterEach(() => {
  stop();
  vi.useRealTimers();
});

describe("plugin notices", () => {
  it("shows a notice once and hides it after the toast time", async () => {
    onNotice({ payload: tap });
    expect(currentPluginNotice()).toEqual({ notice: tap, visible: true });
    await vi.advanceTimersByTimeAsync(TOAST_VISIBLE_MS);
    expect(currentPluginNotice()).toEqual({ notice: tap, visible: false });
  });

  it("treats a repeat of the showing notice as the same one: no second window", async () => {
    onNotice({ payload: tap });
    await vi.advanceTimersByTimeAsync(TOAST_VISIBLE_MS - 1);
    onNotice({ payload: { ...tap } });
    await vi.advanceTimersByTimeAsync(1);
    expect(currentPluginNotice().visible).toBe(false);
  });

  it("replaces a notice for a different plugin", () => {
    showPluginNotice(tap);
    showPluginNotice({ id: "other", kind: "auto_disabled" });
    expect(currentPluginNotice().notice?.id).toBe("other");
  });

  it("hides on dismiss and keeps the notice for the fade", () => {
    showPluginNotice(tap);
    dismissPluginNotice();
    expect(currentPluginNotice()).toEqual({ notice: tap, visible: false });
  });
});
