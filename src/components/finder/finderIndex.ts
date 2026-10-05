/*
 * The quick finder's entries: one per artist, album, single, playlist, genre, present track, and
 * reachable destination, each carrying its searchable fields already folded. Pure and deterministic, so
 * it builds once per library change and the matcher only ever compares folded text. Field 0 is the
 * primary field; the rest are secondary.
 */

// -- Utils Imports --
import { searchFold } from "../../lib/fold";
import { compareMemberOrder } from "../albums/albumLayout";
import { playlistQueue } from "../playlists/playlistPlayback";
import { buildAlbumIndex, resolveTrackAlbum } from "../tracks/trackAlbum";
import { NAV_ORDER, isDestinationVisible } from "../shell/navVisibility";

// -- Type Imports --
import type { Mode } from "../shell/navVisibility";
import type { FinderDestination } from "./finderDestinations";
import type { AppMode } from "../../state/player/store";
import type {
  AlbumRow,
  AlbumTrackRow,
  GenreRow,
  PlaylistRow,
  PlaylistTrackRow,
  TrackRow,
} from "../../types";

/** What an entry stands for. Album and single share the Albums group but act differently. */
export type FinderKind =
  | "artist"
  | "album"
  | "single"
  | "playlist"
  | "genre"
  | "track"
  | "destination";

/** Where an artist name appears: on tracks, as an album artist, or both. */
export type ArtistRole = "track" | "album" | "both";

interface EntryBase {
  label: string;
  sublabel?: string;
  fields: string[];
  // The tracks behind the entry: the play queue for a playable entry, and the recency source for all.
  trackIds: number[];
}

/** An artist, keyed on its folded name, with every exact spelling seen in each role. */
export interface ArtistEntry extends EntryBase {
  kind: "artist";
  id: string;
  role: ArtistRole;
  trackSpellings: string[];
  albumSpellings: string[];
}

/** An album, single, playlist, or genre, with its track count. */
export interface ContainerEntry extends EntryBase {
  kind: "album" | "single" | "playlist" | "genre";
  id: number;
  count: number;
}

export interface TrackEntry extends EntryBase {
  kind: "track";
  id: number;
}

export interface DestinationEntry extends EntryBase {
  kind: "destination";
  id: FinderDestination;
}

export type FinderEntry = ArtistEntry | ContainerEntry | TrackEntry | DestinationEntry;

/** The library rows the index derives from, plus the labels an untitled row falls back to. */
export interface FinderSource {
  tracks: TrackRow[];
  albums: AlbumRow[];
  membership: AlbumTrackRow[];
  playlists: PlaylistRow[];
  slots: PlaylistTrackRow[];
  genres: GenreRow[];
  untitledAlbum: string;
  untitledPlaylist: string;
}

/** The built index: every library entry, a lookup by `entryKey`, and the gone tracks' fields. */
export interface FinderIndex {
  entries: FinderEntry[];
  byKey: Map<string, FinderEntry>;
  // A gone track never shows as a row, but All Tracks still lists it, so the track count needs it.
  goneTrackFields: string[][];
}

/** The stable identity of an entry across rebuilds, as the recents store it. */
export function entryKey(kind: FinderKind, id: number | string): string {
  return `${kind}:${id}`;
}

/** The folded fields that hold text, primary first. A blank secondary drops out. */
function foldFields(primary: string, ...secondary: (string | null)[]): string[] {
  const fields = [searchFold(primary)];
  for (const value of secondary) {
    if (value) fields.push(searchFold(value));
  }
  return fields;
}

/** One artist's tally while the index builds. */
interface ArtistTally {
  spellings: Map<string, number>;
  trackSpellings: Set<string>;
  albumSpellings: Set<string>;
  trackIds: number[];
}

/** The most frequent spelling; a tie goes to the one that sorts first, so the pick never flickers. */
function mostCommonSpelling(spellings: Map<string, number>): string {
  let best = "";
  let bestCount = -1;
  for (const [spelling, count] of spellings) {
    if (count > bestCount || (count === bestCount && spelling < best)) {
      best = spelling;
      bestCount = count;
    }
  }
  return best;
}

/**
 * The artists: every effective track artist over the present tracks, plus every album's album
 * artist, merged on the folded name. Each keeps the spellings it was seen with per role, so a jump to
 * All Tracks can chip every variant.
 */
function artistEntries(present: TrackRow[], albums: AlbumRow[]): ArtistEntry[] {
  const tallies = new Map<string, ArtistTally>();
  const tally = (name: string): ArtistTally | null => {
    const key = searchFold(name);
    if (key === "") return null;
    let entry = tallies.get(key);
    if (!entry) {
      entry = {
        spellings: new Map(),
        trackSpellings: new Set(),
        albumSpellings: new Set(),
        trackIds: [],
      };
      tallies.set(key, entry);
    }
    entry.spellings.set(name, (entry.spellings.get(name) ?? 0) + 1);
    return entry;
  };

  for (const track of present) {
    const name = track.artist_edit ?? track.raw_artist;
    if (!name) continue;
    const entry = tally(name);
    if (!entry) continue;
    entry.trackSpellings.add(name);
    entry.trackIds.push(track.id);
  }
  for (const album of albums) {
    if (!album.album_artist) continue;
    tally(album.album_artist)?.albumSpellings.add(album.album_artist);
  }

  const entries: ArtistEntry[] = [];
  for (const [key, entry] of tallies) {
    const onTracks = entry.trackSpellings.size > 0;
    const onAlbums = entry.albumSpellings.size > 0;
    entries.push({
      kind: "artist",
      id: key,
      label: mostCommonSpelling(entry.spellings),
      fields: [key],
      trackIds: entry.trackIds,
      role: onTracks && onAlbums ? "both" : onTracks ? "track" : "album",
      trackSpellings: [...entry.trackSpellings].sort(),
      albumSpellings: [...entry.albumSpellings].sort(),
    });
  }
  return entries;
}

/** Albums and singles, each queueing its members in drawer order. */
function albumEntries(src: FinderSource): ContainerEntry[] {
  const members = new Map<number, AlbumTrackRow[]>();
  for (const row of src.membership) {
    const list = members.get(row.album_id);
    if (list) list.push(row);
    else members.set(row.album_id, [row]);
  }
  return src.albums.map((album) => {
    const label = album.title ?? src.untitledAlbum;
    const ordered = [...(members.get(album.id) ?? [])].sort(compareMemberOrder);
    return {
      kind: album.kind === "single" ? "single" : "album",
      id: album.id,
      label,
      sublabel: album.album_artist ?? undefined,
      fields: foldFields(label, album.album_artist),
      trackIds: ordered.map((row) => row.track_id),
      count: album.track_count,
    };
  });
}

/** Playlists, each queueing its slots in order. */
function playlistEntries(src: FinderSource): ContainerEntry[] {
  const slots = new Map<number, PlaylistTrackRow[]>();
  for (const slot of src.slots) {
    const list = slots.get(slot.playlist_id);
    if (list) list.push(slot);
    else slots.set(slot.playlist_id, [slot]);
  }
  return src.playlists.map((playlist) => {
    const label = playlist.name ?? src.untitledPlaylist;
    return {
      kind: "playlist",
      id: playlist.id,
      label,
      fields: foldFields(label),
      trackIds: playlistQueue(slots.get(playlist.id) ?? []),
      count: playlist.track_count,
    };
  });
}

/** Genres from the vocabulary, each holding its present tracks for recency. */
function genreEntries(present: TrackRow[], genres: GenreRow[]): ContainerEntry[] {
  const byGenre = new Map<number, number[]>();
  for (const track of present) {
    for (const id of track.genre_ids) {
      const list = byGenre.get(id);
      if (list) list.push(track.id);
      else byGenre.set(id, [track.id]);
    }
  }
  return genres.map((genre) => ({
    kind: "genre",
    id: genre.id,
    label: genre.name,
    fields: foldFields(genre.name),
    trackIds: byGenre.get(genre.id) ?? [],
    count: genre.track_count,
  }));
}

/** A track's display label: the effective title, or the filename when it has none. */
function trackLabel(track: TrackRow): string {
  return track.title_edit ?? track.raw_title ?? track.filename;
}

/**
 * A track's fields: the effective title first, then the effective artist, the resolved album, and the
 * filename - the same text the All Tracks search reads, so the two always agree on a match.
 */
function trackFields(track: TrackRow, albumIndex: Map<number, AlbumRow>): string[] {
  return foldFields(
    trackLabel(track),
    track.artist_edit ?? track.raw_artist,
    resolveTrackAlbum(track, albumIndex),
    track.filename,
  );
}

function trackEntries(present: TrackRow[], albumIndex: Map<number, AlbumRow>): TrackEntry[] {
  return present.map((track) => ({
    kind: "track",
    id: track.id,
    label: trackLabel(track),
    sublabel: (track.artist_edit ?? track.raw_artist) ?? undefined,
    fields: trackFields(track, albumIndex),
    trackIds: [track.id],
  }));
}

/** Every library entry. A track gone from disk gets no entry; it cannot be opened or played. */
export function buildFinderIndex(src: FinderSource): FinderIndex {
  const present = src.tracks.filter((track) => track.missing_at == null);
  const albumIndex = buildAlbumIndex(src.membership, src.albums);
  const entries: FinderEntry[] = [
    ...artistEntries(present, src.albums),
    ...albumEntries(src),
    ...playlistEntries(src),
    ...genreEntries(present, src.genres),
    ...trackEntries(present, albumIndex),
  ];
  const byKey = new Map<string, FinderEntry>();
  for (const entry of entries) byKey.set(entryKey(entry.kind, entry.id), entry);
  const goneTrackFields = src.tracks
    .filter((track) => track.missing_at != null)
    .map((track) => trackFields(track, albumIndex));
  return { entries, byKey, goneTrackFields };
}

/**
 * The destinations a jump can reach under the mode: Home, every visible nav row in order, the
 * possible-duplicates sheet, Settings.
 */
export function finderDestinations(appMode: AppMode): FinderDestination[] {
  const shown = (["home", ...NAV_ORDER] as Mode[]).filter((mode) =>
    isDestinationVisible(appMode, mode),
  );
  return [...shown, "duplicates", "settings"];
}

/** The "Go to" entries for the given destinations and their display labels. */
export function destinationEntries(
  destinations: { mode: FinderDestination; label: string }[],
): DestinationEntry[] {
  return destinations.map(({ mode, label }) => ({
    kind: "destination",
    id: mode,
    label,
    fields: foldFields(label),
    trackIds: [],
  }));
}
