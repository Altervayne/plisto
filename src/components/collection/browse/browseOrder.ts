/*
 * The Browse order: the albums filtered by kind, sorted for a grouping and cut into groups, plus the
 * rail that jumps between them. Pure and clock-injected, derived from the organize snapshot, so the
 * shelf can address any record by offset without a windowed read. Group labels are descriptors; the
 * UI localizes them.
 */

// -- Type Imports --
import type { AlbumRow, AlbumTrackRow, GenreRow } from "../../../types";

export type BrowseBy = "none" | "artist" | "genre" | "year" | "recent";

export const BROWSE_BYS: readonly BrowseBy[] = ["none", "artist", "genre", "year", "recent"];

/** The Albums and Singles chips; a chip off hides its kind. */
export interface BrowseKinds {
  albums: boolean;
  singles: boolean;
}

/** How long ago an album was added, coarsest at the far end. */
export type RecentBucket =
  | { span: "week" }
  | { span: "month" }
  | { span: "thisYear" }
  | { span: "year"; year: number }
  | { span: "before"; year: number };

export type GroupLabel =
  | { kind: "artist"; value: string }
  | { kind: "unknownArtist" }
  | { kind: "genre"; value: string }
  | { kind: "noGenre" }
  | { kind: "decade"; value: number }
  | { kind: "noYear" }
  | { kind: "recent"; bucket: RecentBucket };

export interface BrowseGroup {
  label: GroupLabel;
  /** Index of the group's first record. */
  start: number;
}

export interface BrowseRailEntry {
  key: string;
  /** Index of the first record under the key. */
  index: number;
  /** Set when the rail shows group names rather than letters. */
  label: GroupLabel | null;
}

export interface BrowseOrder {
  by: BrowseBy;
  items: AlbumRow[];
  groups: BrowseGroup[];
  /** Per record, the index of its group; all zero when ungrouped. */
  groupOf: Int32Array;
  /** Per record, the key of the rail entry it falls under. */
  railKey: string[];
  rail: BrowseRailEntry[];
  /** True when the rail is the A-Z letters (None and Artist), false when it is group names. */
  letters: boolean;
  /** The record's index, or null when the album is not in this order. */
  offsetOf: (albumId: number) => number | null;
}

export interface BrowseInput {
  albums: AlbumRow[];
  membership: AlbumTrackRow[];
  genres: GenreRow[];
  by: BrowseBy;
  kinds: BrowseKinds;
  /** Now, in unix seconds. */
  now: number;
}

const DAY = 86400;

/** The rail letters in order: `#` for anything outside A-Z, then A to Z. */
export const RAIL_LETTERS: readonly string[] = ["#", ..."ABCDEFGHIJKLMNOPQRSTUVWXYZ"];

/** Lowercased, diacritics stripped, leading "The " dropped: the key titles and artists sort by. */
export function sortKeyOf(text: string | null): string {
  const plain = (text ?? "").normalize("NFD").replace(/\p{M}/gu, "");
  return plain.trim().replace(/^the\s+/i, "").toLowerCase();
}

/** The rail letter of a sort key, `#` for anything outside A-Z. */
export function initialOf(key: string): string {
  const ch = key.charAt(0).toUpperCase();
  return ch >= "A" && ch <= "Z" ? ch : "#";
}

/** Buckets an album's age. Calendar years come from the clock, so the labels roll over on their own. */
export function recentBucket(createdAt: number, now: number): RecentBucket {
  const days = Math.max(0, Math.floor((now - createdAt) / DAY));
  if (days < 7) return { span: "week" };
  if (days < 30) return { span: "month" };
  const nowYear = new Date(now * 1000).getUTCFullYear();
  const year = new Date(createdAt * 1000).getUTCFullYear();
  if (year >= nowYear) return { span: "thisYear" };
  if (year >= nowYear - 2) return { span: "year", year };
  return { span: "before", year: nowYear - 2 };
}

function bucketKey(b: RecentBucket): string {
  return "year" in b ? `${b.span}:${b.year}` : b.span;
}

function compareText(a: string, b: string): number {
  const x = a.toLowerCase();
  const y = b.toLowerCase();
  if (x < y) return -1;
  if (x > y) return 1;
  return a < b ? -1 : a > b ? 1 : 0;
}

/**
 * The genre an album files under: the one on the most tracks, a tie going to the first alphabetically.
 * `counts` maps genre name to track count; an empty map has no primary genre.
 */
export function primaryGenre(counts: Map<string, number>): string | null {
  let best: string | null = null;
  let bestCount = 0;
  for (const [name, count] of counts) {
    if (count > bestCount || (best !== null && count === bestCount && compareText(name, best) < 0)) {
      best = name;
      bestCount = count;
    }
  }
  return best;
}

/** Per album, the genre names and their track counts (a track with two genres counts for both). */
function genreCountsByAlbum(
  membership: AlbumTrackRow[],
  genres: GenreRow[],
): Map<number, Map<string, number>> {
  const names = new Map(genres.map((g) => [g.id, g.name]));
  const byAlbum = new Map<number, Map<string, number>>();
  for (const row of membership) {
    for (const id of row.genre_ids) {
      const name = names.get(id);
      if (name === undefined) continue;
      let counts = byAlbum.get(row.album_id);
      if (!counts) byAlbum.set(row.album_id, (counts = new Map()));
      counts.set(name, (counts.get(name) ?? 0) + 1);
    }
  }
  return byAlbum;
}

type SortPart = string | number;

function compareParts(a: SortPart[], b: SortPart[]): number {
  for (let i = 0; i < a.length; i++) {
    if (a[i] < b[i]) return -1;
    if (a[i] > b[i]) return 1;
  }
  return 0;
}

interface Keyed {
  album: AlbumRow;
  /** Equal keys share a group. */
  groupKey: string;
  /** Null when ungrouped. */
  label: GroupLabel | null;
  sort: SortPart[];
}

// A leading 0/1 flag in a sort puts the "unknown" bucket after every named one.
function keyAlbum(album: AlbumRow, by: BrowseBy, genre: string | null, now: number): Keyed {
  const title = sortKeyOf(album.title);
  const artist = sortKeyOf(album.album_artist);
  const year = album.year ?? 0;
  switch (by) {
    case "artist": {
      const named = artist !== "";
      return {
        album,
        groupKey: artist,
        label: named
          ? { kind: "artist", value: (album.album_artist ?? "").trim() }
          : { kind: "unknownArtist" },
        sort: [named ? 0 : 1, artist, year, title, album.id],
      };
    }
    case "genre": {
      const key = genre === null ? "" : genre.toLowerCase();
      return {
        album,
        groupKey: key,
        label: genre === null ? { kind: "noGenre" } : { kind: "genre", value: genre },
        sort: [genre === null ? 1 : 0, key, artist, year, title, album.id],
      };
    }
    case "year": {
      const dated = album.year !== null;
      const decade = dated ? Math.floor(year / 10) * 10 : 0;
      return {
        album,
        groupKey: dated ? String(decade) : "",
        label: dated ? { kind: "decade", value: decade } : { kind: "noYear" },
        sort: [dated ? 0 : 1, -year, artist, title, album.id],
      };
    }
    case "recent": {
      const bucket = recentBucket(album.created_at, now);
      return {
        album,
        groupKey: bucketKey(bucket),
        label: { kind: "recent", bucket },
        sort: [-album.created_at, artist, title, album.id],
      };
    }
    default:
      return { album, groupKey: "", label: null, sort: [title, artist, album.id] };
  }
}

/** Filters, sorts and groups the albums for a Browse grouping. */
export function browseOrder(input: BrowseInput): BrowseOrder {
  const { by, kinds, now } = input;
  const counts = by === "genre" ? genreCountsByAlbum(input.membership, input.genres) : null;
  const keyed = input.albums
    .filter((a) => (a.kind === "single" ? kinds.singles : kinds.albums))
    .map((a) => keyAlbum(a, by, counts ? primaryGenre(counts.get(a.id) ?? new Map()) : null, now));
  keyed.sort((a, b) => compareParts(a.sort, b.sort));

  const items = keyed.map((k) => k.album);
  const groups: BrowseGroup[] = [];
  const groupOf = new Int32Array(items.length);
  let current = "";
  keyed.forEach((k, i) => {
    if (k.label && (groups.length === 0 || k.groupKey !== current)) {
      groups.push({ label: k.label, start: i });
      current = k.groupKey;
    }
    groupOf[i] = Math.max(0, groups.length - 1);
  });

  const letters = by === "none" || by === "artist";
  const railKey = keyed.map((k, i) => {
    if (by === "none") return initialOf(sortKeyOf(k.album.title));
    if (by === "artist") return initialOf(sortKeyOf(k.album.album_artist));
    return String(groupOf[i]);
  });
  const rail: BrowseRailEntry[] = [];
  const seen = new Set<string>();
  railKey.forEach((key, i) => {
    if (seen.has(key)) return;
    seen.add(key);
    rail.push({ key, index: i, label: letters ? null : groups[groupOf[i]].label });
  });

  const offsets = new Map(items.map((a, i) => [a.id, i]));
  return {
    by,
    items,
    groups,
    groupOf,
    railKey,
    rail,
    letters,
    offsetOf: (albumId) => offsets.get(albumId) ?? null,
  };
}
