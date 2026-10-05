/*
 * The keyboard nudges for the playhead and the level. The seek bar, the volume rail, and the app-wide
 * shortcuts all step by the same amounts, so the steps and their clamps live here once.
 */

/** How far a seek key nudges the playhead, in seconds. */
export const SEEK_STEP = 5;

/** How far a volume key nudges the level, as a fraction of full. */
export const VOLUME_STEP = 0.05;

/**
 * The playhead `delta` seconds from `position`, held inside the track. Null when the length is unknown:
 * there is nowhere to seek to, and clamping to a zero length would restart the track.
 */
export function nudgeSeek(position: number, duration: number, delta: number): number | null {
  if (!(duration > 0)) return null;
  return Math.min(duration, Math.max(0, position + delta));
}

/** The level `delta` away from `level`, held inside 0..1. */
export function nudgeVolume(level: number, delta: number): number {
  return Math.min(1, Math.max(0, level + delta));
}
