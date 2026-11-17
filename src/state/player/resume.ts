/*
 * The resume blob: what the player saves so the next launch comes back paused on the same track. This
 * file is the pure shape and its normalizer; the writer and the boot restore live beside it. Only library
 * tracks are saved, so an ad-hoc session or a plugin stream never replaces the blob with its own item.
 */

// -- Type Imports --
import type { PlayerStatus, QueueBlock, RepeatMode } from "../../types";

/**
 * The stored shape. Shuffle is deliberately absent: a restored queue plays in its saved order. `blocks`
 * are spans over `ids` and `index` is the row of the current track, both written only when they exist,
 * so a blob from an older build reads the same.
 */
export interface ResumeBlob {
  v: 1;
  ids: number[];
  current_id: number;
  secs: number;
  volume: number;
  repeat: RepeatMode;
  blocks?: QueueBlock[];
  index?: number;
}

/** A blob that survived normalization, ready to hand to the engine. */
export interface ResumeState {
  ids: number[];
  currentId: number;
  secs: number;
  volume: number;
  repeat: RepeatMode;
  blocks?: QueueBlock[];
  index?: number;
}

const REPEATS: readonly string[] = ["off", "all", "one"];

function num(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

/**
 * The saved spans that are sound over `length` ids: integer `[start, length]` pairs of two or more rows,
 * inside the queue, in order and not overlapping. A bad span is dropped on its own.
 */
function validSpans(raw: unknown, length: number): QueueBlock[] {
  if (!Array.isArray(raw)) return [];
  const spans: QueueBlock[] = [];
  let end = 0;
  for (const span of raw) {
    if (!Array.isArray(span) || span.length !== 2) continue;
    const [start, len] = span;
    if (!Number.isInteger(start) || !Number.isInteger(len)) continue;
    if (start < end || len < 2 || start + len > length) continue;
    spans.push([start, len]);
    end = start + len;
  }
  return spans;
}

/**
 * Parses a stored blob into a restorable state, or null when there is nothing to restore: unreadable
 * JSON, an unknown version, no ids, or a current track that is not among the library ids. Negative
 * (ad-hoc) ids drop out, a negative position clamps to zero (the engine clamps past the end), the volume
 * clamps to 0..1 and an unknown repeat reads off. Saved blocks and the current row are kept only while
 * they still describe the ids as written: when any id was dropped the rows shifted, so both are discarded
 * rather than remapped, and a current row that does not hold the current track is discarded too.
 */
export function normalizeResume(raw: string | null | undefined): ResumeState | null {
  if (!raw) return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  if (typeof parsed !== "object" || parsed === null) return null;
  const blob = parsed as Record<string, unknown>;
  if (blob.v !== 1 || !Array.isArray(blob.ids)) return null;

  const ids = blob.ids.filter((id): id is number => Number.isInteger(id) && (id as number) > 0);
  const currentId = blob.current_id;
  if (typeof currentId !== "number" || !ids.includes(currentId)) return null;

  const state: ResumeState = {
    ids,
    currentId,
    secs: Math.max(0, num(blob.secs, 0)),
    volume: Math.min(1, Math.max(0, num(blob.volume, 1))),
    repeat: REPEATS.includes(blob.repeat as string) ? (blob.repeat as RepeatMode) : "off",
  };
  if (ids.length !== blob.ids.length) return state;
  const blocks = validSpans(blob.blocks, ids.length);
  if (blocks.length > 0) state.blocks = blocks;
  const index = blob.index;
  if (typeof index === "number" && Number.isInteger(index) && ids[index] === currentId) {
    state.index = index;
  }
  return state;
}

/** The blob that reads as nothing to restore, carrying the current volume and repeat. */
export function emptyResumeBlob(status: PlayerStatus): ResumeBlob {
  return { v: 1, ids: [], current_id: 0, secs: 0, volume: status.volume, repeat: status.repeat };
}

/**
 * The queue as saved: the library ids (ad-hoc rows leave), the blocks remapped onto them, and the row of
 * the current track `id` when `status.queue_index` names it. A block that loses rows keeps the ones left
 * and is dropped when under two remain.
 */
function savedQueue(
  status: PlayerStatus,
  queue: number[],
  blocks: QueueBlock[],
  id: number,
): Pick<ResumeBlob, "ids" | "blocks" | "index"> {
  // before[i] is how many library rows sit ahead of row i, so it is row i's index in the saved ids.
  const before = [0];
  for (const q of queue) before.push(before[before.length - 1] + (q > 0 ? 1 : 0));
  const kept: QueueBlock[] = [];
  for (const [start, length] of blocks) {
    const first = before[Math.min(start, queue.length)];
    const left = before[Math.min(start + length, queue.length)] - first;
    if (left >= 2) kept.push([first, left]);
  }
  const saved: Pick<ResumeBlob, "ids" | "blocks" | "index"> = { ids: queue.filter((q) => q > 0) };
  if (kept.length > 0) saved.blocks = kept;
  if (queue[status.queue_index] === id) saved.index = before[status.queue_index];
  return saved;
}

/**
 * The blob to persist for the current playback, or null while it must not be written: nothing loaded,
 * an ad-hoc track, or a queue mirror that does not yet hold the current track. `blocks` are the mirror's
 * spans over `queue`.
 *
 * With a stream seated the stream itself is never saved; the parked slot is. A parked track gives the
 * blob it would write with no stream, a cleared parked queue gives an empty blob that reads as nothing to
 * restore, and nothing parked yet keeps the saved blob.
 */
export function buildResumeBlob(
  status: PlayerStatus,
  queue: number[],
  blocks: QueueBlock[] = [],
): ResumeBlob | null {
  const stream = status.stream;
  if (stream) {
    if (stream.parked) {
      const parked = stream.parked.track_id;
      if (parked <= 0 || !queue.includes(parked)) return null;
      return {
        v: 1,
        ...savedQueue(status, queue, blocks, parked),
        current_id: parked,
        secs: stream.parked.secs,
        volume: status.volume,
        repeat: status.repeat,
      };
    }
    return stream.parked_cleared ? emptyResumeBlob(status) : null;
  }

  const id = status.track_id;
  if (id == null || id <= 0 || !queue.includes(id)) return null;
  return {
    v: 1,
    ...savedQueue(status, queue, blocks, id),
    current_id: id,
    secs: status.position_secs,
    volume: status.volume,
    repeat: status.repeat,
  };
}
