/*
 * Seeds an album's metadata from a track selection: the most-common non-null raw value per column,
 * ties broken by first appearance so the result is deterministic. Pure and side-effect free - the
 * action bar computes it once from the selected rows before it creates the album. An all-null column
 * across the selection stays null (unset, resolved to "Untitled" at display, never an empty string).
 */

// -- Type Imports --
import type { AlbumFields, TrackRow } from "../../types";

/** The most-frequent non-null value, or null when every entry is null. Ties keep the first seen. */
function mostCommon<T extends string | number>(values: (T | null)[]): T | null {
  const counts = new Map<T, number>();
  const firstSeen = new Map<T, number>();

  values.forEach((value, index) => {
    if (value == null) return;
    counts.set(value, (counts.get(value) ?? 0) + 1);
    if (!firstSeen.has(value)) firstSeen.set(value, index);
  });

  let best: T | null = null;
  let bestCount = 0;
  for (const [value, count] of counts) {
    if (count > bestCount || (count === bestCount && best != null && firstSeen.get(value)! < firstSeen.get(best)!)) {
      best = value;
      bestCount = count;
    }
  }
  return best;
}

/**
 * Suggests album fields from the selected tracks. Album artist prefers a track's album-artist tag and
 * falls back to its artist, so a clean selection resolves even when only the per-track artist is set.
 */
export function suggestAlbumFields(tracks: TrackRow[]): AlbumFields {
  return {
    title: mostCommon(tracks.map((t) => t.raw_album)),
    album_artist: mostCommon(tracks.map((t) => t.raw_album_artist ?? t.raw_artist)),
    year: mostCommon(tracks.map((t) => t.raw_year)),
    genre: mostCommon(tracks.map((t) => t.raw_genre)),
  };
}
