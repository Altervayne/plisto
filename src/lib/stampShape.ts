/*
 * The shaping behind the tag-write sheet: a preview or a batch summary turned into the groups the sheet
 * draws (results, undone, the diff, the skips) and the scope wording. Pure, so every grouping is tested
 * on its own; the phase machine that drives the sheet lives in stampFlow.
 */

// -- Type Imports --
import type {
  AlbumRow,
  SkipReason,
  StampChange,
  StampEvent,
  StampField,
  StampFilePlan,
  StampOutcome,
  StampPreview,
  StampResultGroup,
  StampScope,
  StampSummary,
  TrackRef,
} from "../types";

/**
 * A batch summary as the sheet holds it. `pointSaved` is null for a summary built from file events, where
 * nothing says whether the restore point was taken; a real finished event sets it.
 */
export type FlowSummary = Omit<StampSummary, "pointSaved"> & { pointSaved: boolean | null };

/** A file named only by its id, when nothing knows more of it. */
function bareRef(trackId: number): TrackRef {
  return { trackId, title: String(trackId), relPath: "", rootLabel: null };
}

/** Names a track the sheet has no plan or earlier summary for, from the library. */
export type TrackLookup = (trackId: number) => TrackRef | undefined;

/** How many tracks a preview leaves alone. */
export function skippedCount(preview: StampPreview): number {
  return preview.skips.reduce((sum, group) => sum + group.tracks.length, 0);
}

/** Whether the preview has no file to write at all. */
export function isNothingToWrite(preview: StampPreview): boolean {
  return preview.files.length === 0;
}

/** The batch the sheet can undo: the files the write (retries included) wrote. */
export function writtenOf(summary: FlowSummary | null): TrackRef[] {
  return summary?.groups.find((g) => g.outcome === "written")?.tracks ?? [];
}

/** A restore point is taken only if both runs took theirs; a run that cannot say leaves it unknown. */
function mergePoint(a: boolean | null, b: boolean | null): boolean | null {
  if (a === false || b === false) return false;
  return a === true && b === true ? true : null;
}

/**
 * Folds a retry's summary into the batch's: every retried track leaves its old group, and any track the
 * retry names replaces its earlier entry, so the result is the same whether the backend reports only the
 * retried files or the whole batch.
 */
export function mergeRetry(prev: FlowSummary, next: FlowSummary, retried: number[]): FlowSummary {
  const touched = new Set<number>(retried);
  for (const group of next.groups) for (const track of group.tracks) touched.add(track.trackId);
  const kept = prev.groups
    .map((group) => ({ ...group, tracks: group.tracks.filter((t) => !touched.has(t.trackId)) }))
    .filter((group) => group.tracks.length > 0);
  const groups = [...kept];
  for (const group of next.groups) {
    const into = groups.find((g) => g.outcome === group.outcome);
    if (into) into.tracks = [...into.tracks, ...group.tracks];
    else groups.push({ outcome: group.outcome, tracks: [...group.tracks] });
  }
  return { ...prev, cancelled: next.cancelled, pointSaved: mergePoint(prev.pointSaved, next.pointSaved), groups };
}

// -- Results --

/** The order the skipped reasons list in: what the user can act on first, "nothing to do" last. */
const SKIP_ORDER: SkipReason[] = [
  "inUse",
  "readOnly",
  "comment",
  "unsupported",
  "offline",
  "missing",
  "edited",
  "changed",
  "unchanged",
];

/** Whether an outcome is a reason a file was left alone, as opposed to written or reverted. */
export function isSkip(outcome: StampOutcome): outcome is SkipReason {
  return outcome !== "written" && outcome !== "reverted";
}

/** Reasons Retry offers: the file may be free, or the failure may not repeat. */
const RETRYABLE: SkipReason[] = ["inUse", "failed"];

/** Whether a result group of this outcome has a Retry. */
export function isRetryable(outcome: StampOutcome): boolean {
  return isSkip(outcome) && RETRYABLE.includes(outcome);
}

function rank(outcome: StampOutcome): number {
  const at = isSkip(outcome) ? SKIP_ORDER.indexOf(outcome) : -1;
  return at < 0 ? SKIP_ORDER.length : at;
}

/** Groups in display order, empty groups dropped. */
function ordered(groups: StampResultGroup[]): StampResultGroup[] {
  return groups.filter((g) => g.tracks.length > 0).sort((a, b) => rank(a.outcome) - rank(b.outcome));
}

/** What the results view draws, derived from a summary and the preview it ran. */
export interface ResultsView {
  written: TrackRef[];
  failed: TrackRef[];
  /** Every other outcome, in display order. */
  skipped: StampResultGroup[];
  skippedCount: number;
  /** Files a stop left unstarted: planned, but named in no group. */
  notStarted: TrackRef[];
}

export function buildResults(summary: FlowSummary, preview: StampPreview | null): ResultsView {
  const written: TrackRef[] = [];
  const failed: TrackRef[] = [];
  const rest: StampResultGroup[] = [];
  for (const group of summary.groups) {
    if (group.outcome === "written") written.push(...group.tracks);
    else if (group.outcome === "failed") failed.push(...group.tracks);
    else if (group.outcome !== "reverted") rest.push(group);
  }
  const skipped = ordered(rest);
  const named = new Set<number>();
  for (const group of summary.groups) for (const track of group.tracks) named.add(track.trackId);
  const notStarted = summary.cancelled
    ? (preview?.files ?? [])
        .filter((file) => !named.has(file.trackId))
        .map(planRef)
    : [];
  return {
    written,
    failed,
    skipped,
    skippedCount: skipped.reduce((sum, g) => sum + g.tracks.length, 0),
    notStarted,
  };
}

/** The track ids a group's Retry sends. */
export function retryIds(tracks: TrackRef[]): number[] {
  return tracks.map((t) => t.trackId);
}

/** What the undone view draws: the files put back, and the ones that kept what they hold. */
export interface UndoneView {
  reverted: TrackRef[];
  kept: StampResultGroup[];
  keptCount: number;
}

export function buildUndone(summary: FlowSummary): UndoneView {
  const reverted: TrackRef[] = [];
  const rest: StampResultGroup[] = [];
  for (const group of summary.groups) {
    if (group.outcome === "reverted") reverted.push(...group.tracks);
    else rest.push(group);
  }
  const kept = ordered(rest);
  return { reverted, kept, keptCount: kept.reduce((sum, g) => sum + g.tracks.length, 0) };
}

// -- The preview --

/** The fixed field order of the confirm. */
export const FIELD_ORDER: StampField[] = [
  "title",
  "artist",
  "album",
  "albumArtist",
  "year",
  "track",
  "disc",
  "genres",
];

/** The fields that at least one file would change. */
export function fieldsPresent(files: StampFilePlan[]): Set<StampField> {
  const found = new Set<StampField>();
  for (const file of files) for (const change of file.changes) found.add(change.field);
  return found;
}

/** A planned file as a track reference. */
export function planRef(file: StampFilePlan): TrackRef {
  return { trackId: file.trackId, title: file.title, relPath: file.relPath, rootLabel: null };
}

/** One diff row: a field's change shared by `files`. */
export interface ChangeRow {
  key: string;
  field: StampField;
  from: string | null;
  to: string;
  files: TrackRef[];
}

/** Rows kept in the by-change list before the rest fold into "show more". */
export const CHANGE_ROW_LIMIT = 60;

/**
 * Groups the planned changes by field and identical before/after, in field order and then by file count.
 * Rows past `limit` are dropped and their files counted, so a library-wide write stays a short list.
 */
export function groupByChange(
  files: StampFilePlan[],
  limit = CHANGE_ROW_LIMIT,
): { rows: ChangeRow[]; hiddenFiles: number } {
  const byKey = new Map<string, ChangeRow>();
  for (const file of files) {
    const ref = planRef(file);
    for (const change of file.changes) {
      const key = JSON.stringify([change.field, change.from, change.to]);
      const row = byKey.get(key);
      if (row) row.files.push(ref);
      else byKey.set(key, { key, field: change.field, from: change.from, to: change.to, files: [ref] });
    }
  }
  const all = [...byKey.values()].sort(
    (a, b) =>
      FIELD_ORDER.indexOf(a.field) - FIELD_ORDER.indexOf(b.field) || b.files.length - a.files.length,
  );
  const hiddenFiles = all.slice(limit).reduce((sum, row) => sum + row.files.length, 0);
  return { rows: all.slice(0, limit), hiddenFiles };
}

/** The fields a file changes, in field order. */
export function fieldsOf(changes: StampChange[]): StampField[] {
  return FIELD_ORDER.filter((field) => changes.some((c) => c.field === field));
}

/** The preview's skip groups in display order. */
export function orderedSkips(preview: StampPreview): StampResultGroup[] {
  return ordered(preview.skips.map((s) => ({ outcome: s.reason, tracks: s.tracks })));
}

/** The offline files of a group counted per folder; a file with no folder name pools under a null label. */
export function groupByRoot(tracks: TrackRef[]): { label: string | null; count: number }[] {
  const counts = new Map<string | null, number>();
  for (const track of tracks) counts.set(track.rootLabel, (counts.get(track.rootLabel) ?? 0) + 1);
  return [...counts].map(([label, count]) => ({ label, count }));
}

// -- Scope wording --

/** What the scope covers, as the sheet's scope line and notes need it. */
export type ScopeInfo =
  | { kind: "album"; title: string; artist: string; tracks: number }
  | { kind: "selection"; album: string; n: number }
  | { kind: "loose"; n: number }
  | { kind: "single"; title: string; artist: string }
  | { kind: "library"; tracks: number }
  | { kind: "albums"; n: number }
  | { kind: "count"; n: number };

/**
 * Names the scope. `albums` is every album and single; `memberOf` maps a track to the album or single
 * it is filed in; `totalTracks` is the library's track count.
 */
export function describeScope(
  scope: StampScope,
  albums: AlbumRow[],
  memberOf: Map<number, AlbumRow>,
  totalTracks: number,
): ScopeInfo {
  if (scope.kind === "library") return { kind: "library", tracks: totalTracks };
  if (scope.kind === "albums") {
    const picked = albums.filter((a) => scope.albumIds.includes(a.id));
    if (picked.length === 1) {
      const [only] = picked;
      return only.kind === "single"
        ? { kind: "single", title: only.title ?? "", artist: only.album_artist ?? "" }
        : { kind: "album", title: only.title ?? "", artist: only.album_artist ?? "", tracks: only.track_count };
    }
    return { kind: "albums", n: picked.length };
  }
  const homes = scope.trackIds.map((id) => memberOf.get(id));
  const filed = homes.filter((h): h is AlbumRow => h != null);
  if (filed.length === 0) return { kind: "loose", n: scope.trackIds.length };
  const first = filed[0];
  if (filed.length === homes.length && filed.every((h) => h.id === first.id)) {
    return first.kind === "single"
      ? { kind: "single", title: first.title ?? "", artist: first.album_artist ?? "" }
      : { kind: "selection", album: first.title ?? "", n: homes.length };
  }
  return { kind: "count", n: scope.trackIds.length };
}

/**
 * Builds a summary from the file events seen so far. `preview` seeds the files it left alone; `known`
 * names tracks the preview does not (a retry or an undo works on the batch's own files); `lookup` names the
 * rest from the library, and a track nothing names still counts, by its id alone.
 */
export function summaryFromEvents(args: {
  batchId: number;
  cancelled: boolean;
  preview: StampPreview | null;
  known: TrackRef[];
  events: StampEvent[];
  lookup?: TrackLookup;
}): FlowSummary {
  const refs = new Map<number, TrackRef>();
  for (const track of args.known) refs.set(track.trackId, track);
  for (const file of args.preview?.files ?? []) refs.set(file.trackId, planRef(file));
  const groups: StampResultGroup[] = [];
  const add = (outcome: StampOutcome, track: TrackRef) => {
    const into = groups.find((g) => g.outcome === outcome);
    if (into) into.tracks.push(track);
    else groups.push({ outcome, tracks: [track] });
  };
  for (const skip of args.preview?.skips ?? []) for (const track of skip.tracks) add(skip.reason, track);
  for (const event of args.events) {
    if (event.kind !== "file") continue;
    add(event.outcome, refs.get(event.trackId) ?? args.lookup?.(event.trackId) ?? bareRef(event.trackId));
  }
  return { batchId: args.batchId, cancelled: args.cancelled, pointSaved: null, groups };
}
