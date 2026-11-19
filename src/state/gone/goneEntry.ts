/*
 * The gone-tracks grouping shared by every surface that reads it. One memoized derivation per scope over
 * the track, root, offline and membership references means the sheet and the rail card read a single
 * computation each. `useGoneSummary` yields nothing until the organization has loaded and holds its
 * track set while a scan streams rows. `useGoneEntry` adds the rail threshold and the dismissal: the newest
 * `missing_at` among the gone tracks when "Not now" was pressed, so the card returns only for a track that
 * went missing after it. A dismissal that could not be read stays quiet rather than nag.
 */

// -- Framework Imports --
import { useCallback, useEffect, useMemo } from "react";
import { useShallow } from "zustand/react/shallow";

// -- State Imports --
import { useAppStore, useOfflineRoots } from "../store";
import { useOrganizeStore } from "../organize/store";
import { useOrgStatus } from "../projectionStatus";
import { useGoneScope } from "../shell/store";
import { ALL_GONE, groupGone, scopeKey } from "./goneGroups";
import {
  PREF_KEYS,
  usePreference,
  usePreferencesLoaded,
  usePreferencesStore,
  useSetPreference,
} from "../preferences/store";

// -- Type Imports --
import type { AlbumTrackRow, Root, TrackRow } from "../../types";
import type { GoneResult, GoneScope } from "./goneGroups";

/** The rail card shows at this many gone tracks, or sooner when a vanished folder is likely moved. */
export const RAIL_GONE_MIN = 50;

interface Memo {
  tracks: TrackRow[];
  roots: Root[];
  offlineIds: number[];
  membership: AlbumTrackRow[];
  results: Map<string, GoneResult>;
}

let memo: Memo | null = null;

/**
 * The gone grouping for a scope. Memoized on the four input references, so any number of callers on the
 * same store state share one grouping per scope.
 */
export function goneResult(
  tracks: TrackRow[],
  roots: Root[],
  offlineIds: number[],
  membership: AlbumTrackRow[],
  scope: GoneScope,
): GoneResult {
  if (
    !memo ||
    memo.tracks !== tracks ||
    memo.roots !== roots ||
    memo.offlineIds !== offlineIds ||
    memo.membership !== membership
  ) {
    memo = { tracks, roots, offlineIds, membership, results: new Map() };
  }
  const key = scopeKey(scope);
  let result = memo.results.get(key);
  if (!result) {
    result = groupGone(tracks, roots, offlineIds, scope, membership);
    memo.results.set(key, result);
  }
  return result;
}

// The track and root sets last read while no scan ran: what a scan holds the grouping at. Null until a
// reader has seen a settled library, and dropped when the last reader unmounts so it cannot go stale.
let settled: { tracks: TrackRow[]; roots: Root[] } | null = null;
let readers = 0;

/** Drops the memo and the settled sets, so the next call regroups. */
export function resetGoneMemo(): void {
  memo = null;
  settled = null;
}

/** True when the grouping is large or telling enough for the rail card. */
export function meetsRailThreshold(result: GoneResult): boolean {
  return result.likely.length > 0 || result.total >= RAIL_GONE_MIN;
}

/** Whether a scan is streaming rows, when the gone counts are not settled. */
export const useGoneScanning = (): boolean => useAppStore((s) => s.scan.status === "scanning");

/** The grouping for a scope, or null until the organization has loaded; held while a scan streams rows. */
function useGoneFor(scope: GoneScope): GoneResult | null {
  const ready = useOrgStatus() === "ready";
  const scanning = useGoneScanning();
  const tracks = useAppStore((s) => s.tracks);
  const roots = useAppStore((s) => s.roots);
  const offlineIds = useOfflineRoots();
  const membership = useOrganizeStore(useShallow((s) => s.org.membership));
  useEffect(() => {
    readers += 1;
    return () => {
      readers -= 1;
      if (readers === 0) settled = null;
    };
  }, []);
  if (!ready) return null;
  if (!scanning) settled = { tracks, roots };
  // A scan streams track rows, so tracks and roots are held at the set read before it began (live when
  // none was read); an offline or membership change still regroups.
  const held = scanning ? settled : null;
  return goneResult(held?.tracks ?? tracks, held?.roots ?? roots, offlineIds, membership, scope);
}

/** The grouping for the scope the shell holds (the open sheet's), or null until the organization has loaded. */
export function useGoneSummary(): GoneResult | null {
  return useGoneFor(useGoneScope());
}

/** The dismissed mark as stored: the newest `missing_at` seen, or null when absent or not a number. */
export function parseDismissedAt(raw: string | undefined): number | null {
  if (raw == null || raw.trim() === "") return null;
  const n = Number(raw);
  return Number.isFinite(n) ? n : null;
}

/** True when some gone track went missing after the dismissed mark. */
export function goneAfter(newestGoneAt: number | null, dismissedAt: number | null): boolean {
  if (newestGoneAt == null) return false;
  return dismissedAt == null || newestGoneAt > dismissedAt;
}

/** The library-wide gone tracks an entry offers and the control that sets them aside. */
export interface GoneEntry {
  summary: GoneResult;
  dismiss: () => void;
}

/**
 * The library-wide gone grouping for an entry that honors "Not now", or null while it is below the
 * threshold, the organization or preferences have not loaded, or no track went missing since the dismissal.
 */
export function useGoneEntry(): GoneEntry | null {
  const summary = useGoneFor(ALL_GONE);
  const loaded = usePreferencesLoaded();
  const raw = usePreference(PREF_KEYS.goneCardDismissed);
  const unreadable = usePreferencesStore((s) => s.failedKeys.has(PREF_KEYS.goneCardDismissed));
  const setPreference = useSetPreference();
  const dismissedAt = useMemo(() => parseDismissedAt(raw), [raw]);
  const dismiss = useCallback(() => {
    if (summary?.newestGoneAt != null) setPreference(PREF_KEYS.goneCardDismissed, String(summary.newestGoneAt));
  }, [summary, setPreference]);

  if (!summary || !loaded || unreadable || !meetsRailThreshold(summary)) return null;
  if (!goneAfter(summary.newestGoneAt, dismissedAt)) return null;
  return { summary, dismiss };
}
