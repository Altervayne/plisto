/*
 * The preferences store: a thin in-memory cache over the settings kv table, read once on mount and
 * written through as prefs change. A pref write is best-effort - a failed setSetting never surfaces
 * to the UI, and the cache stays authoritative for the session. A consumer reads a key and falls
 * back to its own default when the key is absent.
 */

// -- Library Imports --
import { create } from "zustand";

// -- IPC Imports --
import { getSetting, setSetting } from "../../lib/ipc";

/** The persisted preference keys, mapped to their kv-table column names. */
export const PREF_KEYS = {
  drawerWidth: "drawer_width",
  bandHeight: "band_height",
  locale: "locale",
  theme: "theme",
  exportFolderPattern: "export_folder_pattern",
  exportFilePattern: "export_file_pattern",
} as const;

interface PreferencesStore {
  values: Record<string, string>;
  loaded: boolean;

  loadPreferences: () => Promise<void>;
  getPreference: (key: string) => string | undefined;
  setPreference: (key: string, value: string) => void;
}

export const usePreferencesStore = create<PreferencesStore>((set, get) => ({
  values: {},
  loaded: false,

  loadPreferences: async () => {
    const reads = await Promise.all(
      Object.values(PREF_KEYS).map(async (key) => {
        // A failed read leaves the key absent, so the consumer keeps its default.
        try {
          return [key, await getSetting(key)] as const;
        } catch {
          return [key, null] as const;
        }
      }),
    );
    const values: Record<string, string> = {};
    for (const [key, value] of reads) {
      if (value != null) values[key] = value;
    }
    set({ values, loaded: true });
  },

  getPreference: (key) => get().values[key],

  setPreference: (key, value) => {
    set((s) => ({ values: { ...s.values, [key]: value } }));
    // Best-effort persist: a failed pref write is non-fatal, so it never throws into the UI.
    void setSetting(key, value).catch(() => {});
  },
}));

// -- Selectors (narrow: each returns one primitive or one action reference) --

export const usePreferencesLoaded = (): boolean => usePreferencesStore((s) => s.loaded);
export const usePreference = (key: string): string | undefined =>
  usePreferencesStore((s) => s.values[key]);

export const useLoadPreferences = () => usePreferencesStore((s) => s.loadPreferences);
export const useSetPreference = () => usePreferencesStore((s) => s.setPreference);
