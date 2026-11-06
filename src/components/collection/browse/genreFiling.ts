/*
 * Why a record sits where it does under Genre grouping: the genre it files under, how many of its
 * tracks carry it, the genres it tied with, and the rest of its mix. Counts the same way the Browse
 * order does, so the line always agrees with the shelf.
 */

// -- Unit Imports --
import { primaryGenre } from "./browseOrder";

// -- Type Imports --
import type { AlbumTrackRow, GenreRow } from "../../../types";

export interface GenreCount {
  name: string;
  count: number;
}

export interface GenreFiling {
  genre: string;
  count: number;
  total: number;
  /** Other genres on as many tracks as the filed one, which lost the tie alphabetically. */
  tied: string[];
  /** Every genre but the filed one, most tracks first. */
  others: GenreCount[];
}

/** The record's filing, or null when none of its tracks carries a genre. */
export function genreFiling(tracks: AlbumTrackRow[], genres: GenreRow[]): GenreFiling | null {
  const names = new Map(genres.map((g) => [g.id, g.name]));
  const counts = new Map<string, number>();
  for (const row of tracks) {
    for (const id of row.genre_ids) {
      const name = names.get(id);
      if (name !== undefined) counts.set(name, (counts.get(name) ?? 0) + 1);
    }
  }
  const genre = primaryGenre(counts);
  if (genre === null) return null;
  const count = counts.get(genre) ?? 0;
  const others = [...counts]
    .filter(([name]) => name !== genre)
    .map(([name, n]) => ({ name, count: n }))
    .sort((a, b) => b.count - a.count || a.name.toLowerCase().localeCompare(b.name.toLowerCase()));
  return {
    genre,
    count,
    total: tracks.length,
    tied: others.filter((o) => o.count === count).map((o) => o.name),
    others,
  };
}
