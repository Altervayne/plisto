/*
 * Whether a trim may replace its library file in place, and how a failed replace reads. Pure: the
 * caller hands in the switch, the track, the roots and the player's queue, so the rules test without a
 * store. Only Opus is written in place. In use mirrors the back end: the seated track and the one the
 * player opens next, except the track open in the editor while the library is not sounding it - the
 * editor pauses it on entry, and a paused track may be replaced.
 */

// -- Utils Imports --
import { busyKind } from "./busyError";
import type { BusyKind } from "./busyError";
import { spliceFormat } from "./splice";

// -- Type Imports --
import type { PlayerStatus, TrackRow, TrimCancelled, TrimFailure, TrimReplaceJob } from "../types";

/** Why Replace the original is unavailable, in the order the backend refuses them. */
export type ReplaceBlock =
  | { kind: "off" }
  | { kind: "format"; format: string }
  | { kind: "adHoc" }
  | { kind: "missing" }
  | { kind: "offline"; folder: string }
  | { kind: "inUse" }
  | { kind: "stale" };

/** A file Plisto cannot reach: gone from disk, or under a library folder that is offline. */
export type ReachBlock = Extract<ReplaceBlock, { kind: "missing" } | { kind: "offline" }>;

/** The track fields the rules read. */
export interface ReplaceTrack {
  source_path: string;
  ext: string;
  missing_at: number | null;
}

/** A library folder as the rules see it. */
export interface ReplaceRoot {
  id: number;
  path: string;
}

/**
 * Everything the blocker reads. `track` is null for a file that is not in the library; `stale` is an
 * analysis the library row has moved on from.
 */
export interface ReplaceInput {
  enabled: boolean;
  trackId: number;
  ext: string;
  track: ReplaceTrack | null;
  roots: ReplaceRoot[];
  offlineRootIds: number[];
  inUse: boolean;
  stale: boolean;
}

/** A failed replace as the editor words it; a busy kind is a file write or a scan holding the library. */
export interface TrimFailureInfo {
  kind: TrimFailure | BusyKind;
  code: string | null;
}

/** The library row's size and mtime when the editor took its analysis; a replace expects them still. */
export type ReplaceExpect = TrimReplaceJob["expect"];

const FAILURES: readonly TrimFailure[] = [
  "locked",
  "space",
  "denied",
  "changed",
  "inUse",
  "offline",
  "missing",
  "busy",
  "unavailable",
  "other",
];

const CANCELLED: TrimCancelled = "cancelled";

function foldPath(path: string): string {
  const folded = path.toLowerCase().replace(/\\/g, "/");
  return folded.length > 1 && folded.endsWith("/") ? folded.slice(0, -1) : folded;
}

/** The library folder holding `path`: the deepest one when folders nest, or null. */
export function rootOfPath<R extends ReplaceRoot>(path: string, roots: R[]): R | null {
  const file = foldPath(path);
  let best: R | null = null;
  for (const root of roots) {
    const dir = foldPath(root.path);
    if (file !== dir && !file.startsWith(`${dir}/`)) continue;
    if (!best || dir.length > foldPath(best.path).length) best = root;
  }
  return best;
}

/** Why the track's file cannot be reached, or null when nothing says so. */
export function reachBlock(
  track: ReplaceTrack,
  roots: ReplaceRoot[],
  offlineRootIds: number[],
): ReachBlock | null {
  if (track.missing_at != null) return { kind: "missing" };
  const root = rootOfPath(track.source_path, roots);
  if (root && offlineRootIds.includes(root.id)) return { kind: "offline", folder: root.path };
  return null;
}

/** The first reason Replace the original is unavailable, or null when the file may be replaced. */
export function replaceBlock(input: ReplaceInput): ReplaceBlock | null {
  if (!input.enabled) return { kind: "off" };
  const format = spliceFormat(input.ext);
  if (format !== "opus") return { kind: "format", format: (format ?? input.ext).toUpperCase() };
  if (input.trackId < 0 || !input.track) return { kind: "adHoc" };
  const reach = reachBlock(input.track, input.roots, input.offlineRootIds);
  if (reach) return reach;
  if (input.inUse) return { kind: "inUse" };
  if (input.stale) return { kind: "stale" };
  return null;
}

/** A block in the failure kinds a write reports, so a refused undo reads like the back end's refusal. */
export function blockFailure(block: ReplaceBlock): TrimFailure {
  switch (block.kind) {
    case "off":
    case "format":
    case "adHoc":
      return "unavailable";
    case "stale":
      return "changed";
    default:
      return block.kind;
  }
}

/** The queue slot the engine opens after the cursor: the replay under repeat one, a wrap under all. */
function nextInQueue(status: Pick<PlayerStatus, "queue_index" | "repeat">, queue: number[]): number | null {
  const index = status.queue_index;
  let slot: number;
  if (status.repeat === "one") slot = index;
  else if (index + 1 < queue.length) slot = index + 1;
  else if (status.repeat === "all") slot = 0;
  else return null;
  return slot < queue.length ? queue[slot] : null;
}

type InUseStatus = Pick<PlayerStatus, "playing" | "track_id" | "queue_index" | "repeat" | "stream">;

/**
 * The track ids the player holds open or opens next, the current one first; the back end's rule. While a
 * stream is seated its parked library track is next; during a preview the queue cursor is current. A
 * next equal to the current is not listed twice.
 */
export function inUseIds(status: InUseStatus, queue: number[]): number[] {
  let current: number;
  let next: number | null;
  if (status.track_id != null && status.stream) {
    current = status.track_id;
    next = status.stream.parked?.track_id ?? null;
  } else if (status.track_id != null) {
    current = status.track_id;
    next = nextInQueue(status, queue);
  } else {
    if (status.queue_index >= queue.length) return [];
    current = queue[status.queue_index];
    next = nextInQueue(status, queue);
  }
  return next == null || next === current ? [current] : [current, next];
}

/** Whether a replace of `trackId` must wait: held by the player, unless it is the paused current track. */
export function trackInUse(status: InUseStatus, queue: number[], trackId: number): boolean {
  const ids = inUseIds(status, queue);
  if (ids[0] === trackId) return status.playing && status.track_id === trackId;
  return ids.includes(trackId);
}

/**
 * Whether the library row moved on from the analysis the editor holds: an outside edit, or an undo.
 * `lagging` is the store's own row when the analysis was read, if it had not caught up with the file
 * yet; the row still sitting there is not a change.
 */
export function analysisStale(
  expect: ReplaceExpect,
  row: Pick<TrackRow, "size_bytes" | "mtime">,
  lagging: ReplaceExpect | null = null,
): boolean {
  const moved = (from: ReplaceExpect) => row.size_bytes !== from.sizeBytes || row.mtime !== from.mtime;
  return moved(expect) && (lagging == null || moved(lagging));
}

/** Whether a rejection is the cancelled code, the one rejection that is not a failure. */
export function isCancelledRejection(error: unknown): boolean {
  if (error != null && typeof error === "object" && "kind" in error) {
    return (error as { kind: unknown }).kind === CANCELLED;
  }
  return String(error).trim() === CANCELLED;
}

/** The drive or share a path lives on, for the no-room message: "D:" or "\\server\share". */
export function driveOf(path: string): string {
  const letter = /^[A-Za-z]:/.exec(path);
  if (letter) return letter[0].toUpperCase();
  const share = /^\\\\[^\\]+\\[^\\]+/.exec(path);
  return share ? share[0] : path;
}

function isFailure(value: unknown): value is TrimFailure {
  return typeof value === "string" && (FAILURES as readonly string[]).includes(value);
}

/**
 * Reads a rejected replace or undo. The backend answers `{ kind, code }`, or a string led by the kind
 * ("locked", "other: 1392"); a busy lock reads as what holds it, and anything else as `other` with the
 * Windows code when the text carries one.
 */
export function trimFailureOf(error: unknown): TrimFailureInfo {
  const busy = busyKind(error);
  if (busy) return { kind: busy, code: null };
  if (error != null && typeof error === "object" && "kind" in error) {
    const { kind, code } = error as { kind: unknown; code?: unknown };
    if (isFailure(kind)) return { kind, code: code == null ? null : String(code) };
  }
  const text = String(error).trim();
  const led = /^(\w+)\b[:\s]*(.*)$/s.exec(text);
  const kind: TrimFailure = led && isFailure(led[1]) ? led[1] : "other";
  const detail = led && kind === led[1] ? led[2] : text;
  const code = /os error (-?\d+)/.exec(detail) ?? /^(-?\d+)\b/.exec(detail.trim());
  return { kind, code: kind === "other" && code ? code[1] : null };
}
