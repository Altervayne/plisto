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
import { withRetry } from "../../lib/withRetry";

// -- State Imports --
import {
  normalizeReactivity,
  normalizeSpectrumLayout,
  normalizeVisualizerKind,
  type Reactivity,
  type SpectrumLayout,
  type VisualizerKind,
} from "../player/visualizerKind";
import { catalogOf, serializeCatalog, type Catalog, type CatalogState } from "../player/visualizerCatalog";

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
  // The visualizer kinds and families turned off, a JSON blob.
  playerVisualizerCatalog: "player_visualizer_catalog",
  playerVisualizerReactivity: "player_visualizer_reactivity",
  playerSpectrumLayout: "player_spectrum_layout",
  // The resume-on-launch blob: the library queue, current track, position, volume and repeat.
  playerResume: "player_resume",
  // Whether the startup update check runs; only an explicit "0" turns it off.
  updaterAutoCheck: "updater_auto_check",
  // The update version the user skipped; that version no longer prompts on its own.
  updaterSkipped: "updater_skipped",
  // The Collection's last segment; absent or unknown lands on Albums.
  collectionSegment: "collection_segment",
  // "1" once the one-time Browse hint is retired.
  collectionBrowseHint: "collection_browse_hint",
  // Browse's grouping; absent or unknown reads None.
  collectionBrowseGroup: "collection_browse_group",
  // The album id Browse last rested on.
  collectionBrowseFocus: "collection_browse_focus",
  // The Export screen's remembered setups: the last one plus one per destination, a JSON blob.
  exportSetups: "export_setups",
  // "1" once the trim-bar drag hint is retired by the first drag.
  trimHintSeen: "trim_hint_seen",
  // "1" once the flashing-visualizer notice is acknowledged; visualizers draw only then.
  visualizerWarningAck: "visualizer_warning_ack",
  // The albums-from-tags proposal keys set aside with "Not now", a JSON list.
  tagAlbumsDismissed: "tag_albums_dismissed",
  // The newest missing_at among the gone tracks when "Not now" was pressed, a number string.
  goneCardDismissed: "gone_card_dismissed",
  // The two opt-ins to writing into music files, and how long a trim keeps its original. The backend reads
  // these same keys by name and refuses a write command while its switch is off.
  stampFiles: "stampFiles",
  trimReplace: "trimReplace",
  trimBackupDays: "trimBackupDays",
} as const;

interface PreferencesStore {
  values: Record<string, string>;
  /** Keys whose boot read failed even after retries. */
  failedKeys: ReadonlySet<string>;
  loaded: boolean;

  loadPreferences: () => Promise<void>;
  /** Re-reads one key. Success clears it from `failedKeys`; failure leaves it failed. */
  retryPreference: (key: string) => Promise<void>;
  getPreference: (key: string) => string | undefined;
  setPreference: (key: string, value: string) => void;
}

// The order of `setPreference` calls, so a load can tell which keys were written after it began.
let writeCount = 0;
const lastWrite = new Map<string, number>();

export const usePreferencesStore = create<PreferencesStore>((set, get) => ({
  values: {},
  failedKeys: new Set<string>(),
  loaded: false,

  loadPreferences: async () => {
    const started = writeCount;
    const reads = await Promise.all(
      Object.values(PREF_KEYS).map(async (key) => {
        // A read that still fails after the retries leaves the key absent and is recorded, so a
        // consumer that must not overwrite stored data can tell a failed read from an empty one.
        try {
          return [key, await withRetry(() => getSetting(key)), true] as const;
        } catch {
          return [key, null, false] as const;
        }
      }),
    );
    const values: Record<string, string> = {};
    const failedKeys = new Set<string>();
    for (const [key, value, ok] of reads) {
      if (!ok) failedKeys.add(key);
      else if (value != null) values[key] = value;
    }
    // A key written after this load began holds a newer value than the read: it stays as written and is
    // not a failed read.
    const current = get().values;
    for (const [key, at] of lastWrite) {
      if (at <= started) continue;
      values[key] = current[key]!;
      failedKeys.delete(key);
    }
    set({ values, failedKeys, loaded: true });
  },

  retryPreference: async (key) => {
    let value: string | null;
    try {
      value = await withRetry(() => getSetting(key));
    } catch {
      return;
    }
    set((s) => {
      // A key that left failedKeys meanwhile holds a newer value than this read.
      if (!s.failedKeys.has(key)) return s;
      const failedKeys = new Set(s.failedKeys);
      failedKeys.delete(key);
      const values = { ...s.values };
      if (value != null) values[key] = value;
      else delete values[key];
      return { values, failedKeys };
    });
  },

  getPreference: (key) => get().values[key],

  setPreference: (key, value) => {
    lastWrite.set(key, ++writeCount);
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
export const useRetryPreference = () => usePreferencesStore((s) => s.retryPreference);

/** Whether the trim-bar hint is still due: prefs have loaded and no drag has retired it. */
export const useTrimHintDue = (): boolean => {
  const loaded = usePreferencesLoaded();
  return loaded && usePreference(PREF_KEYS.trimHintSeen) !== "1";
};

/** Retires the trim-bar hint for good. A no-op once retired, so a drag does not rewrite the pref per step. */
export const useRetireTrimHint = (): (() => void) => {
  const due = useTrimHintDue();
  const setPreference = useSetPreference();
  return () => {
    if (due) setPreference(PREF_KEYS.trimHintSeen, "1");
  };
};

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

/** Whether Plisto checks for updates after launch. Persisted, default on: only an explicit "0" turns it off. */
export const useUpdaterAutoCheck = (): boolean => usePreference(PREF_KEYS.updaterAutoCheck) !== "0";

/** Flips the startup update check. Best-effort persist like every other pref. */
export const useSetUpdaterAutoCheck = (): ((on: boolean) => void) => {
  const setPreference = useSetPreference();
  return (on) => setPreference(PREF_KEYS.updaterAutoCheck, on ? "1" : "0");
};

/** The picked visualizer for the Player and ambient mode. An absent or unknown pref reads Ridge. */
export const usePlayerVisualizer = (): VisualizerKind =>
  normalizeVisualizerKind(usePreference(PREF_KEYS.playerVisualizer));

/** Persists the visualizer pick. Best-effort like every other pref. */
export const useSetPlayerVisualizer = (): ((kind: VisualizerKind) => void) => {
  const setPreference = useSetPreference();
  return (kind) => setPreference(PREF_KEYS.playerVisualizer, kind);
};

/** Whether the catalog key is unreadable: not loaded yet, or its boot read failed. */
export const selectCatalogUnreadable = (s: { loaded: boolean; failedKeys: ReadonlySet<string> }): boolean =>
  !s.loaded || s.failedKeys.has(PREF_KEYS.playerVisualizerCatalog);

/**
 * The visualizer catalog. Before the read lands, and after it failed, every kind is offered and every
 * write is refused, so an unread value is never overwritten.
 */
export const useVisualizerCatalog = (): Catalog => {
  const raw = usePreference(PREF_KEYS.playerVisualizerCatalog);
  const unreadable = usePreferencesStore(selectCatalogUnreadable);
  return catalogOf(raw, unreadable);
};

/** Persists a catalog state from `toggleKind` or `toggleGroup`. A null state, a refused toggle, writes nothing. */
export function persistVisualizerCatalog(next: CatalogState | null): void {
  if (next) usePreferencesStore.getState().setPreference(PREF_KEYS.playerVisualizerCatalog, serializeCatalog(next));
}

export const useSetVisualizerCatalog = (): ((next: CatalogState | null) => void) => persistVisualizerCatalog;

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

/** How long a trim in place keeps the original: 7 or 30 days, or until the user discards it. */
export type TrimBackupDays = "7" | "30" | "never";

/** The limits in the order Settings offers them. */
export const TRIM_BACKUP_DAYS: readonly TrimBackupDays[] = ["7", "30", "never"];

/** The stored limit; an absent or unknown value reads 30 days. */
export function normalizeTrimBackupDays(raw: string | undefined): TrimBackupDays {
  return TRIM_BACKUP_DAYS.find((days) => days === raw) ?? "30";
}

/** Whether Plisto may write tags into music files. Persisted, default off: only an explicit "1" turns it on. */
export const useStampFiles = (): boolean => usePreference(PREF_KEYS.stampFiles) === "1";

/** Flips the tag-writing opt-in. Best-effort persist like every other pref. */
export const useSetStampFiles = (): ((on: boolean) => void) => {
  const setPreference = useSetPreference();
  return (on) => setPreference(PREF_KEYS.stampFiles, on ? "1" : "0");
};

/** Whether Plisto may replace an Opus file when trimming it. Persisted, default off. */
export const useTrimReplace = (): boolean => usePreference(PREF_KEYS.trimReplace) === "1";

/** Flips the replace-the-original opt-in. Best-effort persist like every other pref. */
export const useSetTrimReplace = (): ((on: boolean) => void) => {
  const setPreference = useSetPreference();
  return (on) => setPreference(PREF_KEYS.trimReplace, on ? "1" : "0");
};

/** How long a replaced file's original is kept. An absent or unknown pref reads 30 days. */
export const useTrimBackupDays = (): TrimBackupDays =>
  normalizeTrimBackupDays(usePreference(PREF_KEYS.trimBackupDays));

/** Persists the backup limit. Best-effort like every other pref. */
export const useSetTrimBackupDays = (): ((days: TrimBackupDays) => void) => {
  const setPreference = useSetPreference();
  return (days) => setPreference(PREF_KEYS.trimBackupDays, days);
};
