// -- Library Imports --
import { beforeEach, describe, expect, it, vi } from "vitest";

// -- IPC Imports --
import { getSetting, setSetting } from "../../lib/ipc";

// -- Unit Imports --
import { PREF_KEYS, usePreferencesStore } from "./store";

vi.mock("../../lib/ipc", () => ({ getSetting: vi.fn(), setSetting: vi.fn() }));

const prefs = () => usePreferencesStore.getState();

/** A load whose reads are taken now and held until `release` is called. */
function heldLoad(disk: Record<string, string>) {
  let release!: () => void;
  const gate = new Promise<void>((resolve) => (release = resolve));
  vi.mocked(getSetting).mockImplementation(async (key) => {
    const value = disk[key] ?? null;
    await gate;
    return value;
  });
  return { release, done: prefs().loadPreferences() };
}

beforeEach(() => {
  vi.mocked(getSetting).mockReset().mockResolvedValue(null);
  vi.mocked(setSetting).mockReset().mockResolvedValue(undefined);
  usePreferencesStore.setState({ values: {}, failedKeys: new Set(), loaded: false });
});

describe("a preference written while a load is in flight", () => {
  it("keeps the written value when the load lands", async () => {
    const { release, done } = heldLoad({});
    await Promise.resolve();
    prefs().setPreference(PREF_KEYS.theme, "dark");
    release();
    await done;
    expect(prefs().values[PREF_KEYS.theme]).toBe("dark");
    expect(prefs().loaded).toBe(true);
  });

  it("beats a different value the load read", async () => {
    const { release, done } = heldLoad({ [PREF_KEYS.theme]: "light" });
    await Promise.resolve();
    prefs().setPreference(PREF_KEYS.theme, "dark");
    release();
    await done;
    expect(prefs().values[PREF_KEYS.theme]).toBe("dark");
  });

  it("is not a failed read even when its own read failed", async () => {
    let release!: () => void;
    const gate = new Promise<void>((resolve) => (release = resolve));
    vi.useFakeTimers();
    vi.mocked(getSetting).mockImplementation(async (key) => {
      await gate;
      if (key === PREF_KEYS.theme) throw new Error("down");
      return null;
    });
    const done = prefs().loadPreferences();
    prefs().setPreference(PREF_KEYS.theme, "dark");
    release();
    await vi.advanceTimersByTimeAsync(60000);
    await done;
    vi.useRealTimers();
    expect(prefs().values[PREF_KEYS.theme]).toBe("dark");
    expect(prefs().failedKeys.has(PREF_KEYS.theme)).toBe(false);
  });

  it("leaves a key written during the load alone while others take the loaded value", async () => {
    const { release, done } = heldLoad({ [PREF_KEYS.locale]: "fr", [PREF_KEYS.theme]: "light" });
    await Promise.resolve();
    prefs().setPreference(PREF_KEYS.exportSetups, "blob");
    release();
    await done;
    expect(prefs().values[PREF_KEYS.exportSetups]).toBe("blob");
    expect(prefs().values[PREF_KEYS.locale]).toBe("fr");
    expect(prefs().values[PREF_KEYS.theme]).toBe("light");
  });

  it("does not hold a key written before the load began", async () => {
    prefs().setPreference(PREF_KEYS.theme, "dark");
    const { release, done } = heldLoad({ [PREF_KEYS.theme]: "light" });
    release();
    await done;
    expect(prefs().values[PREF_KEYS.theme]).toBe("light");
  });
});
