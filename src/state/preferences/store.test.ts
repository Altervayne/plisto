// -- Library Imports --
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// -- IPC Imports --
import { getSetting } from "../../lib/ipc";

// -- Unit Imports --
import { PREF_KEYS, usePreferencesStore } from "./store";

vi.mock("../../lib/ipc", () => ({ getSetting: vi.fn(), setSetting: vi.fn() }));

describe("loadPreferences", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.mocked(getSetting).mockReset();
    usePreferencesStore.setState({ values: {}, failedKeys: new Set(), loaded: false });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("retries a read that fails twice and keeps the value", async () => {
    let calls = 0;
    vi.mocked(getSetting).mockImplementation(async (key) => {
      if (key !== PREF_KEYS.exportSetups) return null;
      if (++calls <= 2) throw new Error("not ready");
      return "blob";
    });
    const done = usePreferencesStore.getState().loadPreferences();
    await vi.advanceTimersByTimeAsync(20000);
    await done;
    const s = usePreferencesStore.getState();
    expect(s.values[PREF_KEYS.exportSetups]).toBe("blob");
    expect(s.failedKeys.size).toBe(0);
    expect(s.loaded).toBe(true);
  });

  it("records a key that keeps failing and leaves it out of the values", async () => {
    vi.mocked(getSetting).mockImplementation(async (key) => {
      if (key === PREF_KEYS.exportSetups) throw new Error("down");
      return key === PREF_KEYS.theme ? "dark" : null;
    });
    const done = usePreferencesStore.getState().loadPreferences();
    await vi.advanceTimersByTimeAsync(20000);
    await done;
    const s = usePreferencesStore.getState();
    expect(s.failedKeys.has(PREF_KEYS.exportSetups)).toBe(true);
    expect(PREF_KEYS.exportSetups in s.values).toBe(false);
    expect(s.values[PREF_KEYS.theme]).toBe("dark");
    expect(s.loaded).toBe(true);
  });
});
