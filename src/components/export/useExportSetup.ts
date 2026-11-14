// -- Framework Imports --
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

// -- State Imports --
import {
  PREF_KEYS,
  usePreference,
  usePreferencesLoaded,
  usePreferencesStore,
  useSetPreference,
} from "../../state/preferences/store";

// -- IPC Imports --
import { checkDevice, destinationPresent, validateExportDestination } from "../../lib/ipc";

// -- Local Imports --
import {
  parseSetups,
  rememberPick,
  rememberRun,
  restorePlan,
  settleRestore,
  setupOnPick,
} from "./exportSetup";
import { DEFAULT_PRESET } from "./templates";

// -- Type Imports --
import type { DestinationCheck, ExportTarget } from "../../types";
import type { ExportScope } from "./scopeState";
import type { PlaylistShape } from "./ExportSections";
import type { Setup, Setups } from "./exportSetup";

/**
 * Checks a remembered destination the way a fresh pick would be. A folder must still exist first,
 * because the validation creates a missing one. A rejected check reads as failed.
 */
async function checkTarget(target: ExportTarget): Promise<DestinationCheck | null> {
  try {
    if (target.kind === "device") return await checkDevice(target.target.pidl);
    if (!(await destinationPresent(target.path))) return null;
    return await validateExportDestination(target.path);
  } catch {
    return null;
  }
}

/** The patterns on screen: the two preferences, or the Artist/Album default when absent. */
function currentLayout(): { folder: string; file: string } {
  const { getPreference } = usePreferencesStore.getState();
  return {
    folder: getPreference(PREF_KEYS.exportFolderPattern) ?? DEFAULT_PRESET.folder,
    file: getPreference(PREF_KEYS.exportFilePattern) ?? DEFAULT_PRESET.file,
  };
}

/**
 * The export screen's setup state: the destination and its check, device mode, scope, the include
 * switches and the playlist shape. Opening the screen restores the last setup and, once the last
 * destination passes its check, the destination too; a pick re-seeds from what that destination
 * remembers. The remembered blob is written on a pick and on a run start, never on a toggle, so
 * leaving the screen untouched keeps the earlier record. The two layout patterns keep living in their
 * own preferences, which the album export dialog shares.
 */
export function useExportSetup() {
  const loaded = usePreferencesLoaded();
  const setPreference = useSetPreference();
  const folder = usePreference(PREF_KEYS.exportFolderPattern) ?? DEFAULT_PRESET.folder;
  const file = usePreference(PREF_KEYS.exportFilePattern) ?? DEFAULT_PRESET.file;

  const [target, setTarget] = useState<ExportTarget | null>(null);
  const [check, setCheck] = useState<DestinationCheck | null>(null);
  const [deviceInPlace, setDeviceInPlace] = useState(false);
  const [scope, setScope] = useState<ExportScope>("all");
  const [includeAlbums, setIncludeAlbums] = useState(true);
  const [includeSingles, setIncludeSingles] = useState(true);
  const [includePlaylists, setIncludePlaylists] = useState(false);
  const [playlistShape, setPlaylistShape] = useState<PlaylistShape>("mimic");

  // Counts user picks so a restore that resolves after one stands down.
  const picks = useRef(0);

  const readSetups = useCallback(
    () =>
      parseSetups(
        usePreferencesStore.getState().getPreference(PREF_KEYS.exportSetups),
        currentLayout(),
      ),
    [],
  );

  // A blob that failed to load is never overwritten: its keys read as absent, not empty.
  const writeSetups = useCallback(
    (next: Setups) => {
      if (usePreferencesStore.getState().failedKeys.has(PREF_KEYS.exportSetups)) return;
      setPreference(PREF_KEYS.exportSetups, JSON.stringify(next));
    },
    [setPreference],
  );

  const applyTaste = useCallback((setup: Setup) => {
    setIncludeAlbums(setup.albums);
    setIncludeSingles(setup.singles);
    setIncludePlaylists(setup.playlists);
    setPlaylistShape(setup.shape);
  }, []);

  // Writes a destination's own layout to the two patterns, only where it differs from what is stored.
  const applyLayout = useCallback(
    (setup: Setup) => {
      const layout = currentLayout();
      if (setup.folder !== layout.folder) setPreference(PREF_KEYS.exportFolderPattern, setup.folder);
      if (setup.file !== layout.file) setPreference(PREF_KEYS.exportFilePattern, setup.file);
    },
    [setPreference],
  );

  // Puts a picked destination's setup on screen. A new destination's setup carries the screen's own
  // layout, so the layout write is a no-op for it.
  const applySetup = useCallback(
    (setup: Setup) => {
      applyLayout(setup);
      applyTaste(setup);
      setDeviceInPlace(setup.deviceInPlace);
      setScope(setup.scope);
    },
    [applyLayout, applyTaste],
  );

  // Restore once the preferences are in. The switches and shape apply at once and the layout stays as
  // the preferences hold it; the destination, the fields that describe it and, for a destination that
  // has been run, its layout wait for the check. A per-run flag, no ref, keeps the effect sound across
  // StrictMode's setup/cleanup/setup.
  useEffect(() => {
    if (!loaded) return;
    if (usePreferencesStore.getState().failedKeys.has(PREF_KEYS.exportSetups)) return;
    let alive = true;
    const startedAt = picks.current;
    const plan = restorePlan(readSetups());
    applyTaste(plan.setup);
    if (!plan.target) return;
    const restoring = plan.target;
    void checkTarget(restoring).then((result) => {
      if (!alive || picks.current !== startedAt) return;
      const settled = settleRestore(plan, !!result?.ok);
      if (!settled.target) return;
      if (settled.applyLayout) applyLayout(settled.setup);
      setDeviceInPlace(settled.setup.deviceInPlace);
      setScope(settled.setup.scope);
      setTarget(settled.target);
      setCheck(result);
    });
    return () => {
      alive = false;
    };
  }, [loaded, readSetups, applyTaste, applyLayout]);

  const current = useMemo<Setup>(
    () => ({
      folder,
      file,
      albums: includeAlbums,
      singles: includeSingles,
      playlists: includePlaylists,
      shape: playlistShape,
      deviceInPlace,
      scope,
    }),
    [folder, file, includeAlbums, includeSingles, includePlaylists, playlistShape, deviceInPlace, scope],
  );

  /** Chooses a destination: re-seeds from what it remembers and records it as the last pick. */
  const pick = useCallback(
    (next: ExportTarget) => {
      picks.current += 1;
      const setups = readSetups();
      const seeded = setupOnPick(setups, next, current);
      applySetup(seeded);
      setTarget(next);
      setCheck(null);
      writeSetups(rememberPick(setups, next, seeded));
    },
    [current, readSetups, applySetup, writeSetups],
  );

  /** Records the setup a run starts with, as the last one and as its destination's own. */
  const remember = useCallback(
    (ran: ExportTarget) => writeSetups(rememberRun(readSetups(), ran, current, Date.now())),
    [current, readSetups, writeSetups],
  );

  return {
    target,
    check,
    setCheck,
    deviceInPlace,
    setDeviceInPlace,
    scope,
    setScope,
    includeAlbums,
    setIncludeAlbums,
    includeSingles,
    setIncludeSingles,
    includePlaylists,
    setIncludePlaylists,
    playlistShape,
    setPlaylistShape,
    pick,
    remember,
  };
}
