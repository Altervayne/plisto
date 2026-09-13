/*
 * The grid's facet model: the chip filters layered over the loaded rows, apart from the free-text
 * search and the column sort. A facet reads the resolved value (edit over raw), so an edited tag
 * matches its own edited value; genre reads the per-track vocabulary membership rather than raw_genre.
 * Pure data and derivations, no React and no store, so the grid and the tests read one source. Within a
 * facet the chosen values are any-of; across facets they all must hold.
 */

// -- Utils Imports --
import {
  isSingleMember,
  resolveTrackAlbum,
  resolveTrackAlbumArtist,
  resolveTrackYear,
} from "./trackAlbum";

// -- Type Imports --
import type { AlbumRow, TrackRow } from "../../types";

/** The facets a chip can filter on. Genre is multi-valued per track; the rest are single resolved tags. */
export type FacetKey = "artist" | "album_artist" | "album" | "genre" | "year";

/** The facets in menu order. */
export const FACET_KEYS: FacetKey[] = ["artist", "album_artist", "album", "genre", "year"];

/** A shared empty album index: the default when a caller has no membership join, so omitting it
 *  reproduces the loose edit-over-raw resolution byte for byte. One frozen reference, never mutated. */
export const EMPTY_INDEX: Map<number, AlbumRow> = Object.freeze(new Map<number, AlbumRow>()) as Map<
  number,
  AlbumRow
>;

/** A grouping dimension: one of the facets, or the flat ungrouped default. */
export type GroupDimension = "none" | FacetKey;

/** One active filter: a facet and one of its values. The chip bar holds a flat list of these. */
export interface GridFacet {
  facet: FacetKey;
  value: string;
}

/**
 * The resolved single-tag value for a facet as a display string; null when absent. Artist reads edit over
 * raw. Album, album-artist, and year join through the album index, so a member inherits its album's field
 * while a per-track edit still wins; an empty index falls back to the loose edit-over-raw.
 */
export function resolveFacet(track: TrackRow, facet: FacetKey, index = EMPTY_INDEX): string | null {
  switch (facet) {
    case "artist": {
      const v = track.artist_edit ?? track.raw_artist;
      return v ? v : null;
    }
    case "album_artist":
      return resolveTrackAlbumArtist(track, index);
    case "album":
      return resolveTrackAlbum(track, index);
    case "year":
      return resolveTrackYear(track, index);
    // Genre is multi-valued and lives in the vocabulary, so it resolves through trackGenreNames.
    case "genre":
      return null;
  }
}

/** The track's genre names, mapped from its genre_ids through the vocabulary. An unknown id drops out. */
export function trackGenreNames(track: TrackRow, genreNameById: Map<number, string>): string[] {
  const names: string[] = [];
  for (const id of track.genre_ids) {
    const name = genreNameById.get(id);
    if (name) names.push(name);
  }
  return names;
}

/** The distinct values each facet offers over the given rows: years newest first, the rest by name. */
export function facetOptions(
  tracks: TrackRow[],
  genreNameById: Map<number, string>,
  index = EMPTY_INDEX,
): Record<FacetKey, string[]> {
  const sets: Record<FacetKey, Set<string>> = {
    artist: new Set(),
    album_artist: new Set(),
    album: new Set(),
    genre: new Set(),
    year: new Set(),
  };
  for (const track of tracks) {
    for (const facet of FACET_KEYS) {
      if (facet === "genre") {
        for (const name of trackGenreNames(track, genreNameById)) sets.genre.add(name);
      } else {
        const value = resolveFacet(track, facet, index);
        if (value != null) sets[facet].add(value);
      }
    }
  }
  return {
    artist: sortValues("artist", sets.artist),
    album_artist: sortValues("album_artist", sets.album_artist),
    album: sortValues("album", sets.album),
    genre: sortValues("genre", sets.genre),
    year: sortValues("year", sets.year),
  };
}

/** A facet's values in menu order: years as numbers newest first, every other facet by name,
 *  case-insensitive. Group headers reuse this so the group order matches the facet menu. */
export function sortValues(facet: FacetKey, values: Set<string>): string[] {
  const list = [...values];
  if (facet === "year") return list.sort((a, b) => Number(b) - Number(a));
  return list.sort((a, b) => a.localeCompare(b, undefined, { sensitivity: "base" }));
}

/** The rows passing the active facets: within a facet any value matches, across facets all must. */
export function filterByFacets(
  tracks: TrackRow[],
  facets: GridFacet[],
  genreNameById: Map<number, string>,
  index = EMPTY_INDEX,
): TrackRow[] {
  if (facets.length === 0) return tracks;
  // Gather each facet's chosen values into an any-of set.
  const byFacet = new Map<FacetKey, Set<string>>();
  for (const { facet, value } of facets) {
    const set = byFacet.get(facet) ?? new Set<string>();
    set.add(value);
    byFacet.set(facet, set);
  }
  return tracks.filter((track) => {
    for (const [facet, values] of byFacet) {
      if (!facetMatches(track, facet, values, genreNameById, index)) return false;
    }
    return true;
  });
}

// One facet's any-of test: a genre matches when the track carries one of the values, a single tag when
// its resolved value is among them.
function facetMatches(
  track: TrackRow,
  facet: FacetKey,
  values: Set<string>,
  genreNameById: Map<number, string>,
  index: Map<number, AlbumRow>,
): boolean {
  if (facet === "genre") {
    return trackGenreNames(track, genreNameById).some((name) => values.has(name));
  }
  const value = resolveFacet(track, facet, index);
  return value != null && values.has(value);
}

/**
 * Whether a track lacks the metadata export needs: its resolved title or artist is empty, or it needs an
 * album and has none. Title and artist read edit over raw; the album joins through the index so a member
 * of a titled album is not flagged. A single is exempt from the album term - it never needs one. The Home
 * count and the All Tracks filter both read this, so they never disagree.
 */
export function isMissingMetadata(track: TrackRow, index = EMPTY_INDEX): boolean {
  const title = track.title_edit ?? track.raw_title;
  if (!title) return true;
  if (resolveFacet(track, "artist") == null) return true;
  return !isSingleMember(track, index) && resolveTrackAlbum(track, index) == null;
}

/** Whether a value is already an active chip for a facet. */
export function hasFacet(facets: GridFacet[], facet: FacetKey, value: string): boolean {
  return facets.some((f) => f.facet === facet && f.value === value);
}

/** Toggles a facet value: adds the chip when absent, drops it when present. */
export function toggleFacet(facets: GridFacet[], facet: FacetKey, value: string): GridFacet[] {
  return hasFacet(facets, facet, value)
    ? facets.filter((f) => !(f.facet === facet && f.value === value))
    : [...facets, { facet, value }];
}

/** Drops one chip. */
export function removeFacet(facets: GridFacet[], facet: FacetKey, value: string): GridFacet[] {
  return facets.filter((f) => !(f.facet === facet && f.value === value));
}
