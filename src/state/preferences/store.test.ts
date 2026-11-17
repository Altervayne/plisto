// -- Library Imports --
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// -- IPC Imports --
import { getSetting, setSetting } from "../../lib/ipc";

// -- State Imports --
import { catalogOf, toggleKind } from "../player/visualizerCatalog";

// -- Unit Imports --
import { PREF_KEYS, persistVisualizerCatalog, selectCatalogUnreadable, usePreferencesStore } from "./store";

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

describe("retryPreference", () => {
  const key = PREF_KEYS.playerVisualizerCatalog;

  beforeEach(() => {
    vi.useFakeTimers();
    vi.mocked(getSetting).mockReset();
    usePreferencesStore.setState({ values: { theme: "dark" }, failedKeys: new Set([key, "other"]), loaded: true });
  });

  afterEach(() => {
    vi.useRealTimers();
  });

  it("clears the key from failedKeys and fills its value on success", async () => {
    vi.mocked(getSetting).mockResolvedValue('{"v":1,"kinds":["ink"],"groups":[]}');
    await usePreferencesStore.getState().retryPreference(key);
    const s = usePreferencesStore.getState();
    expect(s.failedKeys.has(key)).toBe(false);
    expect(s.failedKeys.has("other")).toBe(true);
    expect(s.values[key]).toBe('{"v":1,"kinds":["ink"],"groups":[]}');
    expect(s.values.theme).toBe("dark");
    expect(getSetting).toHaveBeenCalledWith(key);
  });

  it("keeps a newer value that landed while the retry was in flight", async () => {
    let resolve: (value: string | null) => void = () => {};
    vi.mocked(getSetting).mockReturnValue(new Promise((r) => (resolve = r)));
    const done = usePreferencesStore.getState().retryPreference(key);
    usePreferencesStore.setState({ values: { [key]: "newer" }, failedKeys: new Set(["other"]) });
    resolve("older");
    await done;
    expect(usePreferencesStore.getState().values[key]).toBe("newer");
  });

  it("leaves the key failed when the read keeps failing", async () => {
    vi.mocked(getSetting).mockRejectedValue(new Error("down"));
    const done = usePreferencesStore.getState().retryPreference(key);
    await vi.advanceTimersByTimeAsync(20000);
    await done;
    const s = usePreferencesStore.getState();
    expect(s.failedKeys.has(key)).toBe(true);
    expect(key in s.values).toBe(false);
  });
});

describe("visualizer catalog preference", () => {
  const key = PREF_KEYS.playerVisualizerCatalog;

  beforeEach(() => {
    vi.mocked(setSetting).mockReset();
    vi.mocked(setSetting).mockResolvedValue(undefined as never);
    usePreferencesStore.setState({ values: {}, failedKeys: new Set(), loaded: true });
  });

  it("is stored under its own key", () => {
    expect(key).toBe("player_visualizer_catalog");
  });

  it("reads unreadable before the load and after a failed read, readable otherwise", () => {
    expect(selectCatalogUnreadable({ loaded: false, failedKeys: new Set() })).toBe(true);
    expect(selectCatalogUnreadable({ loaded: true, failedKeys: new Set([key]) })).toBe(true);
    expect(selectCatalogUnreadable({ loaded: true, failedKeys: new Set(["theme"]) })).toBe(false);
  });

  it("writes a serialized next state and skips a refused toggle", () => {
    persistVisualizerCatalog(toggleKind(catalogOf(undefined, false), "ink"));
    expect(setSetting).toHaveBeenCalledWith(key, '{"v":1,"kinds":["ink"],"groups":[]}');
    expect(usePreferencesStore.getState().values[key]).toBe('{"v":1,"kinds":["ink"],"groups":[]}');
    persistVisualizerCatalog(toggleKind(catalogOf(undefined, true), "ink"));
    expect(setSetting).toHaveBeenCalledTimes(1);
  });

  it("does not re-render a reader on an unrelated pref write", () => {
    // A component re-renders only when one of its selector results changes identity.
    const selectors = [
      (s: ReturnType<typeof usePreferencesStore.getState>) => s.values[key],
      selectCatalogUnreadable,
    ];
    const read = () => selectors.map((sel) => sel(usePreferencesStore.getState()));
    let last = read();
    let renders = 0;
    const unsubscribe = usePreferencesStore.subscribe(() => {
      const next = read();
      if (next.some((v, i) => !Object.is(v, last[i]))) renders++;
      last = next;
    });
    usePreferencesStore.getState().setPreference(key, '{"v":1,"kinds":["ink"],"groups":[]}');
    const first = catalogOf(last[0] as string, last[1] as boolean);
    usePreferencesStore.getState().setPreference(PREF_KEYS.theme, "light");
    usePreferencesStore.getState().setPreference(PREF_KEYS.locale, "fr");
    unsubscribe();
    expect(renders).toBe(1);
    expect(catalogOf(last[0] as string, last[1] as boolean)).toBe(first);
  });
});
