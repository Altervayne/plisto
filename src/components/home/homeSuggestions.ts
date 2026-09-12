/*
 * The Home suggestion derivations: pure reads over the loaded library and the play-log rows the boxes
 * already hold. No React, no store, no scores - one honest continuation and a couple of artist reads,
 * so the components stay thin and the rules live in one tested place. A missing-source track (missing_at
 * set) never surfaces as a suggestion, matching the wall.
 */

// -- Unit Imports --
import { resolveFacet } from "../tracks/trackFacets";

// -- Type Imports --
import type { TrackRow } from "../../types";

/** A track plays only while its source is present. */
function playable(track: TrackRow): boolean {
  return track.missing_at == null;
}

/** The resolved title, edit over raw, or null when neither layer holds one. */
function resolveTitle(track: TrackRow): string | null {
  const v = track.title_edit ?? track.raw_title;
  return v ? v : null;
}

/**
 * How many tracks lack the metadata export needs. A track counts when its resolved title, artist, or
 * album is empty - the same edit-over-raw resolve the facets do, aligned with the Unknown/Untitled
 * substitution export falls back to. Year and track number are pattern-optional there, so they never
 * count here.
 */
export function countMissingMetadata(tracks: TrackRow[]): number {
  let count = 0;
  for (const track of tracks) {
    if (
      resolveTitle(track) == null ||
      resolveFacet(track, "artist") == null ||
      resolveFacet(track, "album") == null
    ) {
      count += 1;
    }
  }
  return count;
}

/** Why a continuation was picked: the next track in the seed's album, or another by its artist. */
export type PlayNextReason =
  | { kind: "album"; album: string }
  | { kind: "artist"; artist: string };

/** A continuation: the track to play next and the reason that names it on the box. */
export interface PlayNext {
  track: TrackRow;
  reason: PlayNextReason;
}

/**
 * The one continuation to offer after the seed, or null, paired with why it was chosen. Album-next
 * first: the first playable track after the seed within its album order, named by the seed's album.
 * Else another playable track by the seed's resolved artist, skipping the seed and anything played
 * recently, named by that artist. Else nothing - never a fabricated fallback. `seedAlbumTracks` is the
 * seed's album in play order (empty when the seed is loose); `artistTracks` its resolved-artist
 * candidates drawn from the index.
 */
export function pickPlayNext(
  seed: TrackRow,
  seedAlbumTracks: TrackRow[],
  artistTracks: TrackRow[],
  recentIds: readonly number[],
): PlayNext | null {
  const seedIndex = seedAlbumTracks.findIndex((t) => t.id === seed.id);
  if (seedIndex >= 0) {
    for (let i = seedIndex + 1; i < seedAlbumTracks.length; i += 1) {
      if (playable(seedAlbumTracks[i])) {
        return { track: seedAlbumTracks[i], reason: { kind: "album", album: resolveFacet(seed, "album") ?? "" } };
      }
    }
  }
  const skip = new Set<number>(recentIds);
  skip.add(seed.id);
  for (const track of artistTracks) {
    if (playable(track) && !skip.has(track.id)) {
      return { track, reason: { kind: "artist", artist: resolveFacet(seed, "artist") ?? "" } };
    }
  }
  return null;
}

/** The resolved artist of the most-played track, or null when there is no play-log yet. */
export function topArtistFrom(mostPlayedRows: TrackRow[]): string | null {
  const top = mostPlayedRows[0];
  return top ? resolveFacet(top, "artist") : null;
}

/**
 * Up to `limit` playable tracks whose resolved artist matches, in index order, skipping missing-source
 * and any excluded id.
 */
export function tracksByArtist(
  tracks: TrackRow[],
  artist: string,
  limit: number,
  excludeIds: readonly number[] = [],
): TrackRow[] {
  const skip = new Set<number>(excludeIds);
  const out: TrackRow[] = [];
  for (const track of tracks) {
    if (out.length >= limit) break;
    if (!playable(track) || skip.has(track.id)) continue;
    if (resolveFacet(track, "artist") === artist) out.push(track);
  }
  return out;
}
