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

// -- State Imports --
import {
  normalizeReactivity,
  normalizeSpectrumLayout,
  normalizeVisualizerKind,
  type Reactivity,
  type SpectrumLayout,
  type VisualizerKind,
} from "../player/visualizerKind";

/** The persisted preference keys, mapped to their kv-table column names. */
export const PREF_KEYS = {
  drawerWidth: "drawer_width",
  bandHeight: "band_height",
  locale: "locale",
  theme: "theme",
  exportFolderPattern: "export_folder_pattern",
  exportFilePattern: "export_file_pattern",
  spliceNamingPattern: "splice_naming_pattern",
  spliceDestination: "splice_destination",
  spliceThresholdDb: "splice_threshold_db",
  splicePaddingMs: "splice_padding_ms",
  playerEnabled: "player_enabled",
  appMode: "app_mode",
  outputDevice: "output_device",
  // The backend reads this same kv key by name to seed its close-behavior mirror, so both sides
  // spell it identically.
  closeToTray: "closeToTray",
  // Read by the backend under this same name to start or stop the background library sync.
  keepLibraryUpToDate: "keepLibraryUpToDate",
  // The Home bento's saved layout per app mode, each a serialized box list. A mode with no saved
  // layout falls back to its seed; the first arrange edit persists the whole layout here.
  homeLayoutPlayer: "home_layout_player",
  homeLayoutOrganizer: "home_layout_organizer",
  homeLayoutBoth: "home_layout_both",
  // The quick finder's last opened entries, a JSON list of kind and id.
  finderRecent: "finder_recent",
  // The EQ, preamp and levelling blob. The backend parses and applies this same key by name.
  sound: "sound",
  playerVisualizer: "player_visualizer",
  playerVisualizerReactivity: "player_visualizer_reactivity",
  playerSpectrumLayout: "player_spectrum_layout",
  // The resume-on-launch blob: the library queue, current track, position, volume and repeat.
  playerResume: "player_resume",
  // The update version the user put off with Later; that version no longer prompts on its own.
  updaterDismissed: "updater_dismissed",
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

/**
 * Whether closing the window keeps Plisto alive in the tray. Persisted, default off: an absent pref
 * reads off, so the close quits the app until the user opts into the tray.
 */
export const useCloseToTray = (): boolean => usePreference(PREF_KEYS.closeToTray) === "1";

/** Flips the close-behavior pref. Best-effort persist like every other pref. */
export const useSetCloseToTray = (): ((on: boolean) => void) => {
  const setPreference = useSetPreference();
  return (on) => setPreference(PREF_KEYS.closeToTray, on ? "1" : "0");
};

/**
 * Whether the library keeps itself current in the background. Persisted, default on: only an explicit
 * "0" turns it off, matching how the backend reads the same key.
 */
export const useKeepLibraryUpToDate = (): boolean =>
  usePreference(PREF_KEYS.keepLibraryUpToDate) !== "0";

/** Flips the keep-up-to-date pref; the backend hears the write and starts or stops the sync. */
export const useSetKeepLibraryUpToDate = (): ((on: boolean) => void) => {
  const setPreference = useSetPreference();
  return (on) => setPreference(PREF_KEYS.keepLibraryUpToDate, on ? "1" : "0");
};

/** The picked visualizer for the Player and ambient mode. An absent or unknown pref reads Ridge. */
export const usePlayerVisualizer = (): VisualizerKind =>
  normalizeVisualizerKind(usePreference(PREF_KEYS.playerVisualizer));

/** Persists the visualizer pick. Best-effort like every other pref. */
export const useSetPlayerVisualizer = (): ((kind: VisualizerKind) => void) => {
  const setPreference = useSetPreference();
  return (kind) => setPreference(PREF_KEYS.playerVisualizer, kind);
};

/** How hard the visualizers move with the music. An absent or unknown pref reads Balanced. */
export const usePlayerVisualizerReactivity = (): Reactivity =>
  normalizeReactivity(usePreference(PREF_KEYS.playerVisualizerReactivity));

/** Persists the reactivity level. Best-effort like every other pref. */
export const useSetPlayerVisualizerReactivity = (): ((level: Reactivity) => void) => {
  const setPreference = useSetPreference();
  return (level) => setPreference(PREF_KEYS.playerVisualizerReactivity, level);
};

/** How the dot spectrum lays out its columns. An absent or unknown pref reads bass-left. */
export const usePlayerSpectrumLayout = (): SpectrumLayout =>
  normalizeSpectrumLayout(usePreference(PREF_KEYS.playerSpectrumLayout));

/** Persists the dot spectrum's layout. Best-effort like every other pref. */
export const useSetPlayerSpectrumLayout = (): ((layout: SpectrumLayout) => void) => {
  const setPreference = useSetPreference();
  return (layout) => setPreference(PREF_KEYS.playerSpectrumLayout, layout);
};
