/*
 * The pure parts of the lab's `port-nets` mode: the tick the host would send for one lab frame, and the
 * median and worst of the frame costs a mount reported.
 */

// -- Type Imports --
import type { Tick } from "../../visRuntime/protocol";
import type { SongFrame } from "./labSong";

/** The median and the worst of a run of frame costs in ms, or null for an empty run. */
export function frameStats(ms: readonly number[]): { medianMs: number; worstMs: number } | null {
  if (ms.length === 0) return null;
  const sorted = [...ms].sort((a, b) => a - b);
  const mid = sorted.length >> 1;
  const medianMs = sorted.length % 2 === 1 ? sorted[mid] : (sorted[mid - 1] + sorted[mid]) / 2;
  return { medianMs, worstMs: sorted[sorted.length - 1] };
}

export interface TickBuilder {
  /** The tick for the song's next frame, `dt` seconds after the last, numbered from 1. */
  next: (song: SongFrame, t: number, dt: number) => Tick;
}

/** Builds the lab's ticks the way the host builds its own: one per frame, carrying beat count and time. */
export function createTickBuilder(withFine: boolean): TickBuilder {
  let seq = 0;
  let beatAt: number | null = null;
  return {
    next(song, t, dt) {
      const beats = song.sig.beat > 0 ? 1 : 0;
      if (beats > 0) beatAt = t;
      seq += 1;
      return {
        seq,
        t,
        dt,
        sig: song.sig,
        nBeats: beats,
        beatAt,
        rawBands: song.bands,
        fine: withFine ? song.fine : null,
        playing: true,
        trackSeq: 0,
        progress: null,
        pointer: null,
        wave: null,
      };
    },
  };
}
