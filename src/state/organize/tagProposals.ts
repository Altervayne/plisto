/*
 * The library-wide albums-from-tags proposals, shared by every surface that offers them. One memoized
 * derivation over the tracks, albums and membership references means the Unsorted band, the Home line and
 * any further entry read a single computation. `useTagProposals` yields nothing until the organization has
 * loaded and holds its track set while a scan streams rows. `useTagEntry` adds the dismissal: the keys
 * of the proposals in view when "Not now" was pressed, so the entry returns only for a proposal not in
 * that set. A dismissal that could not be read stays quiet rather than nag.
 */

// -- Framework Imports --
import { useCallback, useMemo } from "react";
import { useShallow } from "zustand/react/shallow";

// -- State Imports --
import { useAppStore } from "../store";
import { useOrganizeStore } from "./store";
import { groupByAlbumTags } from "./groupByAlbumTags";
import { useOrgStatus } from "../projectionStatus";
import {
  PREF_KEYS,
  usePreference,
  usePreferencesLoaded,
  usePreferencesStore,
  useSetPreference,
} from "../preferences/store";

// -- Type Imports --
import type { AlbumRow, AlbumTrackRow, TrackRow } from "../../types";

/** What the entries say: how many albums the tags make, from how many tracks, out of how many loose ones. */
export interface TagProposalSummary {
  keys: string[];
  albumCount: number;
  trackCount: number;
  looseCount: number;
}

interface Memo {
  tracks: TrackRow[];
  albums: AlbumRow[];
  membership: AlbumTrackRow[];
  summary: TagProposalSummary;
}

let memo: Memo | null = null;

/**
 * The proposals over every loose track in the library. Memoized on the three input references, so any
 * number of callers on the same store state share one grouping.
 */
export function tagProposalSummary(
  tracks: TrackRow[],
  albums: AlbumRow[],
  membership: AlbumTrackRow[],
): TagProposalSummary {
  if (memo && memo.tracks === tracks && memo.albums === albums && memo.membership === membership) {
    return memo.summary;
  }
  const filed = new Set(membership.map((r) => r.track_id));
  const loose = tracks.filter((t) => !filed.has(t.id));
  const preview = groupByAlbumTags(loose, albums, membership);
  const summary: TagProposalSummary = {
    keys: preview.proposals.map((p) => p.key),
    albumCount: preview.proposals.length,
    trackCount: preview.trackCount,
    looseCount: loose.length,
  };
  memo = { tracks, albums, membership, summary };
  return summary;
}

/** Drops the memo, so the next call regroups. */
export function resetTagProposalMemo(): void {
  memo = null;
}

/**
 * The library-wide proposals, or null when there is nothing to offer: the organization has not loaded
 * (every track would read as loose), or the tags make no album. While a scan runs the last result is held
 * rather than regrouped per streamed batch.
 */
export function useTagProposals(): TagProposalSummary | null {
  const ready = useOrgStatus() === "ready";
  const scanning = useAppStore((s) => s.scan.status === "scanning");
  const tracks = useAppStore((s) => s.tracks);
  const albums = useOrganizeStore(useShallow((s) => s.org.albums));
  const membership = useOrganizeStore(useShallow((s) => s.org.membership));
  if (!ready) return null;
  // A scan streams track rows, so those are held at the last grouped set; an albums or membership change
  // (a filed batch) still regroups.
  const summary = tagProposalSummary(scanning && memo ? memo.tracks : tracks, albums, membership);
  return summary.albumCount > 0 ? summary : null;
}

/** The dismissed proposal keys as stored: a JSON list, anything else reading as none. */
export function parseDismissedKeys(raw: string | undefined): Set<string> {
  if (!raw) return new Set();
  try {
    const parsed: unknown = JSON.parse(raw);
    if (!Array.isArray(parsed)) return new Set();
    return new Set(parsed.filter((k): k is string => typeof k === "string"));
  } catch {
    return new Set();
  }
}

/** True when some proposal key is absent from the dismissed set. */
export function hasUndismissedKey(keys: string[], dismissed: Set<string>): boolean {
  return keys.some((key) => !dismissed.has(key));
}

/** The proposals an entry offers and the control that sets them aside. */
export interface TagEntry {
  summary: TagProposalSummary;
  dismiss: () => void;
}

/**
 * The proposals for an entry that honors "Not now", or null while there is nothing to offer, the
 * preferences have not loaded, or every proposal was already dismissed. A proposal key that was not in
 * the dismissed set brings the entry back.
 */
export function useTagEntry(): TagEntry | null {
  const summary = useTagProposals();
  const loaded = usePreferencesLoaded();
  const raw = usePreference(PREF_KEYS.tagAlbumsDismissed);
  const unreadable = usePreferencesStore((s) => s.failedKeys.has(PREF_KEYS.tagAlbumsDismissed));
  const setPreference = useSetPreference();
  const dismissed = useMemo(() => parseDismissedKeys(raw), [raw]);
  const dismiss = useCallback(() => {
    if (summary) setPreference(PREF_KEYS.tagAlbumsDismissed, JSON.stringify(summary.keys));
  }, [summary, setPreference]);

  if (!summary || !loaded || unreadable || !hasUndismissedKey(summary.keys, dismissed)) return null;
  return { summary, dismiss };
}
