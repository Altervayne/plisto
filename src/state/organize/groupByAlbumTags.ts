/*
 * Groups loose tracks into album proposals by their album tags. Pure and deterministic: it reads the
 * effective tags (edit over raw), keys each track on its folded album and album artist, and describes
 * each group - display spelling, seed fields, play order, existing albums it matches, and what deserves
 * a note or a closer look. A null album artist is its own key and never merges with a tagged one of the
 * same title. Nothing here decides what gets written; the review sheet turns proposals into plans.
 */

// -- Utils Imports --
import { foldId, parentId } from "../files/folderTree";
import { mostCommon } from "./suggestFields";

// -- Type Imports --
import type { AlbumFields, AlbumRow, AlbumTrackRow, TrackRow } from "../../types";

/** A neutral note on a proposal. The row stays checked. */
export type ProposalNote =
  | { kind: "years"; year: number }
  | { kind: "genres" }
  | { kind: "unnumbered"; count: number; all: boolean }
  | { kind: "gap" }
  | { kind: "compilation" }
  | { kind: "missing"; count: number };

/** A reason to look before filing. The row starts unchecked. `collides` only arises on an existing target. */
export type ProposalWarning = { kind: "folders" } | { kind: "duplicates" } | { kind: "collides" };

/** An existing album a proposal's tags match, and whether its numbering clashes with the incoming tracks. */
export interface ProposalMatch {
  album: AlbumRow;
  collides: boolean;
}

/** One group of loose tracks that shares an album tag. `key` is stable across re-runs of the same tags. */
export interface TagAlbumProposal {
  key: string;
  tracks: TrackRow[];
  title: string;
  fields: AlbumFields;
  discCount: number;
  missingCount: number;
  matches: ProposalMatch[];
  notes: ProposalNote[];
  warnings: ProposalWarning[];
}

/** Every proposal in scope, plus what was left out: tracks that stay loose and all-missing groups. */
export interface TagAlbumPreview {
  proposals: TagAlbumProposal[];
  trackCount: number;
  looseCount: number;
  skippedMissing: number;
}

/**
 * The comparison form of a tag: whitespace runs collapse to one space, ends trim, NFC, lowercase. The
 * same fold the backend applies to genre keys, so both sides agree on what counts as one spelling.
 */
export function fold(s: string): string {
  return s.replace(/\s+/g, " ").trim().normalize("NFC").toLowerCase();
}

/** The folded tag, or null when it is absent or blank. */
function foldOrNull(s: string | null): string | null {
  if (s == null) return null;
  const folded = fold(s);
  return folded === "" ? null : folded;
}

/** Trims a seed value and drops it to null when blank; an album never stores an empty string. */
function clean(s: string | null): string | null {
  const trimmed = s?.trim() ?? "";
  return trimmed === "" ? null : trimmed;
}

const effectiveAlbum = (t: TrackRow): string | null => t.album_edit ?? t.raw_album;
const effectiveAlbumArtist = (t: TrackRow): string | null => t.album_artist_edit ?? t.raw_album_artist;
const effectiveArtist = (t: TrackRow): string | null => t.artist_edit ?? t.raw_artist;
const effectiveYear = (t: TrackRow): number | null => t.year_edit ?? t.raw_year;

/** A track's disc, the edit over the raw tag, with an unset disc read as disc 1. */
export const effectiveDisc = (t: TrackRow): number => t.disc_edit ?? t.raw_disc_no ?? 1;

/** Play order: disc, then track number with unnumbered tracks last, then path, then id. */
export function comparePlayOrder(a: TrackRow, b: TrackRow): number {
  const byDisc = effectiveDisc(a) - effectiveDisc(b);
  if (byDisc !== 0) return byDisc;
  const noA = a.raw_track_no ?? Infinity;
  const noB = b.raw_track_no ?? Infinity;
  if (noA !== noB) return noA < noB ? -1 : 1;
  if (a.source_path !== b.source_path) return a.source_path < b.source_path ? -1 : 1;
  return a.id - b.id;
}

/**
 * `trackIds` sorted into play order, so a hand-picked album files its tracks the way the tag grouping
 * does. An id with no row in `tracks` keeps its relative place after the known ones.
 */
export function inPlayOrder(trackIds: number[], tracks: TrackRow[]): number[] {
  const byId = new Map(tracks.map((t) => [t.id, t] as const));
  const known = trackIds.map((id) => byId.get(id)).filter((t): t is TrackRow => t !== undefined);
  const unknown = trackIds.filter((id) => !byId.has(id));
  return [...known.sort(comparePlayOrder).map((t) => t.id), ...unknown];
}

/** The grouping key: the folded album and album artist, a blank artist folding to null. */
function tagKey(album: string | null, albumArtist: string | null): string {
  return JSON.stringify([foldOrNull(album), foldOrNull(albumArtist)]);
}

/** Groups items by a derived key, keeping each group in input order. */
function groupBy<T, K>(items: T[], keyOf: (item: T) => K): Map<K, T[]> {
  const groups = new Map<K, T[]>();
  for (const item of items) {
    const key = keyOf(item);
    const group = groups.get(key);
    if (group) group.push(item);
    else groups.set(key, [item]);
  }
  return groups;
}

/**
 * Proposes albums from `tracks` (the loose tracks in scope). `albums` and `membership` are the organize
 * projection, read for existing-album matches and their numbering. A group whose tracks are all missing
 * is skipped; a one-track group is proposed only when it matches an existing album.
 */
export function groupByAlbumTags(
  tracks: TrackRow[],
  albums: AlbumRow[],
  membership: AlbumTrackRow[],
): TagAlbumPreview {
  const tagged = tracks.filter((t) => foldOrNull(effectiveAlbum(t)) != null);
  let looseCount = tracks.length - tagged.length;
  const groups = groupBy(tagged, (t) => tagKey(effectiveAlbum(t), effectiveAlbumArtist(t)));

  // Existing plain albums under the same key; a single is never a target.
  const albumsByKey = groupBy(
    albums.filter((a) => a.kind === "album" && foldOrNull(a.title) != null),
    (a) => tagKey(a.title, a.album_artist),
  );
  const membersOf = (albumId: number): AlbumTrackRow[] =>
    membership.filter((r) => r.album_id === albumId);

  const proposals: TagAlbumProposal[] = [];
  let skippedMissing = 0;
  for (const [key, members] of groups) {
    const ordered = [...members].sort(comparePlayOrder);
    const missingCount = ordered.filter((t) => t.missing_at != null).length;
    if (missingCount === ordered.length) {
      skippedMissing += 1;
      continue;
    }
    const proposal = describeGroup(key, ordered, missingCount);
    // Match on the album artist a new album would be seeded with, so a group that borrows its track
    // artist finds the album an earlier run created under that same artist.
    const matched = albumsByKey.get(tagKey(proposal.title, proposal.fields.album_artist)) ?? [];
    if (ordered.length === 1 && matched.length === 0) {
      looseCount += 1;
      continue;
    }
    proposals.push({
      ...proposal,
      matches: matched.map((album) => ({ album, collides: collides(ordered, membersOf(album.id)) })),
    });
  }

  proposals.sort(compareProposals);
  const trackCount = proposals.reduce((sum, p) => sum + p.tracks.length, 0);
  return { proposals, trackCount, looseCount, skippedMissing };
}

/** Builds one proposal from a group already in play order, before any existing album is matched. */
function describeGroup(key: string, ordered: TrackRow[], missingCount: number): TagAlbumProposal {
  const notes: ProposalNote[] = [];
  const warnings: ProposalWarning[] = [];

  const title = mostCommon(ordered.map(effectiveAlbum)) ?? "";
  // Every track in the group folds to the same album artist, so the first one speaks for all.
  const tagged = foldOrNull(effectiveAlbumArtist(ordered[0])) != null;

  // With no album artist tag, a shared track artist stands in; varied or absent artists mean a
  // compilation, left without an album artist rather than an invented one.
  let albumArtist = tagged ? mostCommon(ordered.map(effectiveAlbumArtist)) : null;
  if (!tagged) {
    const artistKeys = new Set(ordered.map((t) => foldOrNull(effectiveArtist(t))));
    const [only] = artistKeys;
    if (artistKeys.size === 1 && only != null) {
      albumArtist = mostCommon(ordered.map(effectiveArtist));
    } else {
      notes.push({ kind: "compilation" });
    }
  }

  const year = mostCommon(ordered.map(effectiveYear));
  if (new Set(ordered.map(effectiveYear).filter((y) => y != null)).size > 1 && year != null) {
    notes.push({ kind: "years", year });
  }

  const genre = mostCommon(ordered.map((t) => t.raw_genre));
  const genreKeys = new Set(ordered.map((t) => foldOrNull(t.raw_genre)).filter((g) => g != null));
  if (genreKeys.size > 1) notes.push({ kind: "genres" });

  const unnumbered = ordered.filter((t) => t.raw_track_no == null).length;
  if (unnumbered > 0) {
    notes.push({ kind: "unnumbered", count: unnumbered, all: unnumbered === ordered.length });
  }

  const discs = groupBy(ordered, effectiveDisc);
  let gap = false;
  let duplicates = false;
  for (const discTracks of discs.values()) {
    const numbers = discTracks.map((t) => t.raw_track_no).filter((n): n is number => n != null);
    const distinct = new Set(numbers);
    if (distinct.size < numbers.length) duplicates = true;
    if (distinct.size > 0 && Math.max(...distinct) > distinct.size) gap = true;
  }
  if (gap) notes.push({ kind: "gap" });
  if (missingCount > 0) notes.push({ kind: "missing", count: missingCount });

  if (!foldersExplainedByDiscs(ordered)) warnings.push({ kind: "folders" });
  if (duplicates) warnings.push({ kind: "duplicates" });

  return {
    key,
    tracks: ordered,
    title,
    fields: {
      title: clean(title),
      album_artist: clean(albumArtist),
      year,
      genre: clean(genre),
    },
    discCount: discs.size,
    missingCount,
    matches: [],
    notes,
    warnings,
  };
}

/**
 * True when the group sits in one folder, or when its folders are the discs of one release: each folder
 * holds a single disc, no two folders share a disc, and every folder sits under the same parent.
 */
function foldersExplainedByDiscs(ordered: TrackRow[]): boolean {
  const folders = groupBy(ordered, (t) => parentId(foldId(t.source_path)));
  if (folders.size <= 1) return true;

  const seenDiscs = new Set<number>();
  const parents = new Set<string>();
  for (const [folder, folderTracks] of folders) {
    const discs = new Set(folderTracks.map(effectiveDisc));
    if (discs.size !== 1) return false;
    const [disc] = discs;
    if (seenDiscs.has(disc)) return false;
    seenDiscs.add(disc);
    parents.add(parentId(folder));
  }
  return parents.size === 1;
}

/**
 * True when an incoming track number lands inside the existing numbering of its disc in the target
 * album, so appending would read as a clash rather than a continuation.
 */
function collides(incoming: TrackRow[], members: AlbumTrackRow[]): boolean {
  const ranges = new Map<number, { lo: number; hi: number }>();
  for (const r of members) {
    if (r.track_no == null) continue;
    const disc = r.disc_no ?? 1;
    const range = ranges.get(disc);
    if (range) {
      range.lo = Math.min(range.lo, r.track_no);
      range.hi = Math.max(range.hi, r.track_no);
    } else {
      ranges.set(disc, { lo: r.track_no, hi: r.track_no });
    }
  }
  return incoming.some((t) => {
    const range = ranges.get(effectiveDisc(t));
    const n = t.raw_track_no;
    return range != null && n != null && n >= range.lo && n <= range.hi;
  });
}

/** Wall order: album artist, then title, a missing artist last; the key breaks any remaining tie. */
function compareProposals(a: TagAlbumProposal, b: TagAlbumProposal): number {
  const artistA = a.fields.album_artist;
  const artistB = b.fields.album_artist;
  if (artistA == null && artistB != null) return 1;
  if (artistA != null && artistB == null) return -1;
  if (artistA != null && artistB != null) {
    const byArtist = artistA.localeCompare(artistB, undefined, { sensitivity: "base" });
    if (byArtist !== 0) return byArtist;
  }
  const byTitle = a.title.localeCompare(b.title, undefined, { sensitivity: "base" });
  if (byTitle !== 0) return byTitle;
  return a.key < b.key ? -1 : a.key > b.key ? 1 : 0;
}
