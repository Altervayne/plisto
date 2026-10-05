/*
 * The quick finder's matcher: scores entries against a typed query and lays the hits out in capped
 * groups. Every query token must hit some field. A token scores by where it lands - the field's start,
 * a word start inside it, or anywhere - and a primary-field hit outweighs a secondary one. The order is
 * total, so the same library and query always produce the same rows.
 */

// -- Utils Imports --
import { matchesTokens, searchTokens } from "../../lib/tokenMatch";

// -- Type Imports --
import type { FinderEntry, FinderKind } from "./finderIndex";

/** The result groups, in their fallback order. Albums holds singles too. */
export type FinderGroupKey = "artists" | "albums" | "playlists" | "genres" | "tracks" | "destinations";

const GROUP_ORDER: FinderGroupKey[] = [
  "artists",
  "albums",
  "playlists",
  "genres",
  "tracks",
  "destinations",
];

const GROUP_OF: Record<FinderKind, FinderGroupKey> = {
  artist: "artists",
  album: "albums",
  single: "albums",
  playlist: "playlists",
  genre: "genres",
  track: "tracks",
  destination: "destinations",
};

/** How many hits each group shows, and the most rows the whole result renders. */
export const GROUP_CAP: Record<FinderGroupKey, number> = {
  artists: 5,
  albums: 5,
  playlists: 5,
  genres: 5,
  tracks: 10,
  destinations: 5,
};
export const TOTAL_CAP = 30;

/** A primary-field hit counts this many times a secondary one. */
export const PRIMARY_WEIGHT = 2;

/** One matched entry, its score, and the last time any of its tracks played (unix seconds). */
export interface FinderHit {
  entry: FinderEntry;
  score: number;
  lastPlayedAt: number | null;
}

export interface FinderGroup {
  key: FinderGroupKey;
  hits: FinderHit[];
}

/** The groups to render, plus how many tracks matched before the cap. */
export interface FinderResults {
  groups: FinderGroup[];
  trackMatches: number;
}

const EMPTY_RESULTS: FinderResults = { groups: [], trackMatches: 0 };

const WORD_CHAR = /[\p{L}\p{N}]/u;

/** 3 when the field starts with the token, 2 when a word inside it does, 1 for any other hit, else 0. */
export function tokenScore(field: string, token: string): number {
  if (field.startsWith(token)) return 3;
  let best = 0;
  for (let at = field.indexOf(token, 1); at > 0; at = field.indexOf(token, at + 1)) {
    if (!WORD_CHAR.test(field[at - 1])) return 2;
    best = 1;
  }
  return best;
}

/** The sum of each token's best weighted hit. Only meaningful for fields that match every token. */
export function scoreEntry(fields: string[], tokens: string[]): number {
  let total = 0;
  for (const token of tokens) {
    let best = 0;
    for (let i = 0; i < fields.length; i += 1) {
      const score = tokenScore(fields[i], token) * (i === 0 ? PRIMARY_WEIGHT : 1);
      if (score > best) best = score;
    }
    total += best;
  }
  return total;
}

/** Containers rank ahead of tracks on a tie; destinations come last. */
function kindRank(kind: FinderKind): number {
  if (kind === "track") return 1;
  if (kind === "destination") return 2;
  return 0;
}

/** The latest play among the entry's tracks, or null when none has played. */
function latestPlay(trackIds: number[], lastPlayed: ReadonlyMap<number, number>): number | null {
  let latest: number | null = null;
  for (const id of trackIds) {
    const at = lastPlayed.get(id);
    if (at != null && (latest == null || at > latest)) latest = at;
  }
  return latest;
}

function compareIds(a: FinderEntry, b: FinderEntry): number {
  if (a.kind !== b.kind) return a.kind < b.kind ? -1 : 1;
  if (typeof a.id === "number" && typeof b.id === "number") return a.id - b.id;
  const left = String(a.id);
  const right = String(b.id);
  return left === right ? 0 : left < right ? -1 : 1;
}

/** Score, then containers before tracks, then the most recent play, then the shorter label, then id. */
export function compareHits(a: FinderHit, b: FinderHit): number {
  return (
    b.score - a.score ||
    kindRank(a.entry.kind) - kindRank(b.entry.kind) ||
    (b.lastPlayedAt ?? -1) - (a.lastPlayedAt ?? -1) ||
    a.entry.label.length - b.entry.label.length ||
    compareIds(a.entry, b.entry)
  );
}

// Groups order by their best hit; a tie puts container groups first, then the fallback order.
function compareGroups(a: FinderGroup, b: FinderGroup): number {
  const containerA = a.key === "tracks" || a.key === "destinations" ? 1 : 0;
  const containerB = b.key === "tracks" || b.key === "destinations" ? 1 : 0;
  return (
    b.hits[0].score - a.hits[0].score ||
    containerA - containerB ||
    GROUP_ORDER.indexOf(a.key) - GROUP_ORDER.indexOf(b.key)
  );
}

/**
 * Matches the query over every source list and returns the capped, ordered groups. `lastPlayed` maps a
 * track id to its last play; it only breaks ties, so an empty map still ranks correctly. `hiddenTracks`
 * holds the fields of tracks that never show as rows (gone from disk) but still sit in All Tracks, so
 * the track count matches what the hand-off there lands on.
 */
export function searchFinder(
  sources: readonly (readonly FinderEntry[])[],
  query: string,
  lastPlayed: ReadonlyMap<number, number>,
  hiddenTracks: readonly (readonly string[])[] = [],
): FinderResults {
  const tokens = searchTokens(query);
  if (tokens.length === 0) return EMPTY_RESULTS;

  const hits: FinderHit[] = [];
  for (const entries of sources) {
    for (const entry of entries) {
      if (!matchesTokens(entry.fields, tokens)) continue;
      const score = scoreEntry(entry.fields, tokens);
      hits.push({ entry, score, lastPlayedAt: latestPlay(entry.trackIds, lastPlayed) });
    }
  }
  hits.sort(compareHits);

  const byGroup = new Map<FinderGroupKey, FinderHit[]>();
  let trackMatches = 0;
  for (const fields of hiddenTracks) {
    if (matchesTokens(fields, tokens)) trackMatches += 1;
  }
  for (const hit of hits) {
    const key = GROUP_OF[hit.entry.kind];
    if (key === "tracks") trackMatches += 1;
    const list = byGroup.get(key) ?? [];
    if (list.length < GROUP_CAP[key]) list.push(hit);
    byGroup.set(key, list);
  }

  const ordered = [...byGroup]
    .map(([key, list]) => ({ key, hits: list }))
    .sort(compareGroups);

  // The total cap trims from the end, so the weakest groups give way first.
  const groups: FinderGroup[] = [];
  let room = TOTAL_CAP;
  for (const group of ordered) {
    if (room === 0) break;
    const kept = group.hits.slice(0, room);
    room -= kept.length;
    groups.push({ key: group.key, hits: kept });
  }
  return { groups, trackMatches };
}
