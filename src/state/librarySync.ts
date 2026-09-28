/*
 * The pure rules behind the background library sync on the frontend: merging fetched rows into the
 * track list by id, folding delta payloads into one pending set, and reading a session's totals as a
 * scan summary. Kept free of the store so each rule is tested on its own.
 */

// -- Type Imports --
import type {
  LibraryDelta,
  LibrarySyncSummary,
  RootWatchState,
  ScanSummary,
  TrackRow,
} from "../types";

/** Where a summary came from: a blocking scan's own result, or a background session's totals. */
export type SummarySource = "blocking" | "sync";

/** A scan summary tagged with its origin, since the two read differently on the summary line. */
export type LibrarySummary = ScanSummary & { source: SummarySource };

/** The deltas gathered but not yet applied: row ids to fetch, or a full reload. */
export interface PendingDelta {
  ids: number[];
  reload: boolean;
}

export const NO_DELTA: PendingDelta = { ids: [], reload: false };

/** Folds one `library:delta` payload into the pending set. A reload swallows the ids it would refetch. */
export function mergeDelta(pending: PendingDelta, delta: LibraryDelta): PendingDelta {
  if ("reload" in delta || pending.reload) return { ids: [], reload: true };
  const seen = new Set(pending.ids);
  const ids = [...pending.ids];
  for (const id of delta.ids) {
    if (!seen.has(id)) {
      seen.add(id);
      ids.push(id);
    }
  }
  return { ids, reload: false };
}

/**
 * The track list with `fresh` rows in place: a row whose id is already listed replaces it where it
 * stands, a new id is appended. Applying the same rows again gives the same list.
 */
export function mergeRowsById(rows: TrackRow[], fresh: TrackRow[]): TrackRow[] {
  if (fresh.length === 0) return rows;
  const byId = new Map(fresh.map((r) => [r.id, r]));
  const merged = rows.map((r) => {
    const next = byId.get(r.id);
    if (!next) return r;
    byId.delete(r.id);
    return next;
  });
  for (const r of byId.values()) merged.push(r);
  return merged;
}

/**
 * A background session's totals as a summary. A session walks only what changed, so it carries no
 * library-wide file counts, and it never removes rows.
 */
export function summaryFromSync(s: LibrarySyncSummary): LibrarySummary {
  return {
    source: "sync",
    total: 0,
    seen: 0,
    inserted: s.inserted,
    updated: s.updated,
    skipped: 0,
    removed: 0,
    missing: s.missing,
    returned: s.returned,
    errors: s.errors,
    cancelled: false,
    offline_roots: s.offline_roots,
    deferred: s.deferred,
  };
}

/** The roots to flag offline: the ones the sync reports unreachable now, plus the last summary's. */
export function offlineRootIds(states: RootWatchState[], lastSummary: number[]): number[] {
  const ids = new Set(lastSummary);
  for (const s of states) if (s.mode === "offline") ids.add(s.id);
  return [...ids];
}
