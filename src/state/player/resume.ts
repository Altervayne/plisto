/*
 * The resume blob: what the player saves so the next launch comes back paused on the same track. This
 * file is the pure shape and its normalizer; the writer and the boot restore live beside it. Only library
 * tracks are saved, so an ad-hoc session never replaces the blob.
 */

// -- Type Imports --
import type { PlayerStatus, RepeatMode } from "../../types";

/** The stored shape. Shuffle is deliberately absent: a restored queue plays in its saved order. */
export interface ResumeBlob {
  v: 1;
  ids: number[];
  current_id: number;
  secs: number;
  volume: number;
  repeat: RepeatMode;
}

/** A blob that survived normalization, ready to hand to the engine. */
export interface ResumeState {
  ids: number[];
  currentId: number;
  secs: number;
  volume: number;
  repeat: RepeatMode;
}

const REPEATS: readonly string[] = ["off", "all", "one"];

function num(value: unknown, fallback: number): number {
  return typeof value === "number" && Number.isFinite(value) ? value : fallback;
}

/**
 * Parses a stored blob into a restorable state, or null when there is nothing to restore: unreadable
 * JSON, an unknown version, no ids, or a current track that is not among the library ids. Negative
 * (ad-hoc) ids drop out, a negative position clamps to zero (the engine clamps past the end), the volume
 * clamps to 0..1 and an unknown repeat reads off.
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

  return {
    ids,
    currentId,
    secs: Math.max(0, num(blob.secs, 0)),
    volume: Math.min(1, Math.max(0, num(blob.volume, 1))),
    repeat: REPEATS.includes(blob.repeat as string) ? (blob.repeat as RepeatMode) : "off",
  };
}

/**
 * The blob to persist for the current playback, or null while it must not be written: nothing loaded,
 * an ad-hoc track, or a queue mirror that does not yet hold the current track.
 */
export function buildResumeBlob(status: PlayerStatus, queue: number[]): ResumeBlob | null {
  const id = status.track_id;
  if (id == null || id <= 0 || !queue.includes(id)) return null;
  return {
    v: 1,
    ids: queue.filter((q) => q > 0),
    current_id: id,
    secs: status.position_secs,
    volume: status.volume,
    repeat: status.repeat,
  };
}
