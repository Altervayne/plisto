// -- Test Imports --
import { beforeEach, describe, expect, it } from "vitest";

// -- Unit Imports --
import {
  hasUndismissedKey,
  parseDismissedKeys,
  resetTagProposalMemo,
  tagProposalSummary,
} from "./tagProposals";

// -- Type Imports --
import type { AlbumRow, AlbumTrackRow, TrackRow } from "../../types";

function track(id: number, tags: Partial<TrackRow> = {}): TrackRow {
  return {
    id,
    source_path: `/m/f${id % 300}/${id}.mp3`,
    filename: `${id}.mp3`,
    ext: "mp3",
    size_bytes: 1,
    mtime: 1,
    duration_secs: 100,
    raw_title: `title ${id}`,
    raw_artist: null,
    raw_album: null,
    raw_album_artist: null,
    raw_track_no: null,
    raw_disc_no: null,
    raw_year: null,
    raw_genre: null,
    scanned_at: 1,
    missing_at: null,
    display_path: `/m/f${id % 300}/${id}.mp3`,
    title_edit: null,
    artist_edit: null,
    album_edit: null,
    album_artist_edit: null,
    year_edit: null,
    disc_edit: null,
    genre_ids: [],
    ...tags,
  };
}

function album(id: number, title: string, artist: string): AlbumRow {
  return {
    id,
    title,
    album_artist: artist,
    year: null,
    genre: null,
    cover_id: null,
    kind: "album",
    track_count: 0,
    created_at: 1,
    updated_at: 1,
  };
}

function member(albumId: number, trackId: number, trackNo: number): AlbumTrackRow {
  return {
    album_id: albumId,
    track_id: trackId,
    source_path: `/m/x/${trackId}.mp3`,
    filename: `${trackId}.mp3`,
    duration_secs: 100,
    track_no: trackNo,
    disc_no: 1,
    raw_title: null,
    raw_artist: null,
    title_override: null,
    artist_override: null,
    has_embedded_cover: null,
    missing_at: null,
    keep_own_cover: false,
    genre_ids: [],
  };
}

/** `count` tracks of one tagged album, numbered from `firstNo`. */
function tagged(firstId: number, count: number, title: string, artist: string, firstNo = 1): TrackRow[] {
  return Array.from({ length: count }, (_, i) =>
    track(firstId + i, {
      raw_album: title,
      raw_album_artist: artist,
      raw_artist: artist,
      raw_track_no: firstNo + i,
    }),
  );
}

beforeEach(resetTagProposalMemo);

describe("tagProposalSummary", () => {
  it("counts albums and tracks over the loose tracks only", () => {
    const filed = tagged(1, 3, "Filed", "A");
    const loose = [...tagged(10, 4, "Mezzanine", "Massive Attack"), ...tagged(20, 2, "Migration", "Bonobo")];
    const untagged = [track(30), track(31)];
    const albums = [album(1, "Filed", "A")];
    const membership = filed.map((t, i) => member(1, t.id, i + 1));
    const summary = tagProposalSummary([...filed, ...loose, ...untagged], albums, membership);
    expect(summary.albumCount).toBe(2);
    expect(summary.trackCount).toBe(6);
    expect(summary.looseCount).toBe(8);
    expect(summary.keys).toHaveLength(2);
  });

  it("reports nothing for a library with no album tags", () => {
    const summary = tagProposalSummary([track(1), track(2)], [], []);
    expect(summary.albumCount).toBe(0);
    expect(summary.keys).toEqual([]);
  });

  it("returns the same result for the same inputs and a fresh one when an input changes", () => {
    const tracks = tagged(1, 3, "Mezzanine", "Massive Attack");
    const albums: AlbumRow[] = [];
    const membership: AlbumTrackRow[] = [];
    const first = tagProposalSummary(tracks, albums, membership);
    expect(tagProposalSummary(tracks, albums, membership)).toBe(first);
    expect(tagProposalSummary([...tracks], albums, membership)).not.toBe(first);
  });

  it("derives a library of 50,000 tracks within a sane bound", () => {
    // 4,000 filed albums of ten, 800 loose tagged albums of ten (100 of them matching a filed album),
    // and 2,000 untagged loose tracks.
    const tracks: TrackRow[] = [];
    const albums: AlbumRow[] = [];
    const membership: AlbumTrackRow[] = [];
    let id = 1;
    for (let a = 0; a < 4000; a++) {
      albums.push(album(a + 1, `Filed ${a}`, `Artist ${a % 500}`));
      for (let n = 0; n < 10; n++) {
        tracks.push(track(id, { raw_album: `Filed ${a}`, raw_album_artist: `Artist ${a % 500}`, raw_track_no: n + 1 }));
        membership.push(member(a + 1, id, n + 1));
        id += 1;
      }
    }
    for (let a = 0; a < 800; a++) {
      const matches = a < 100;
      const title = matches ? `Filed ${a}` : `Loose ${a}`;
      const artist = matches ? `Artist ${a % 500}` : `Loose Artist ${a % 200}`;
      for (const t of tagged(id, 10, title, artist, matches ? 11 : 1)) tracks.push(t);
      id += 10;
    }
    while (tracks.length < 50_000) tracks.push(track(id++));

    const start = performance.now();
    const summary = tagProposalSummary(tracks, albums, membership);
    const elapsed = performance.now() - start;

    expect(summary.albumCount).toBe(800);
    expect(summary.trackCount).toBe(8000);
    expect(elapsed).toBeLessThan(5000);
  });
});

describe("dismissed keys", () => {
  it("reads a stored list and treats anything else as empty", () => {
    expect([...parseDismissedKeys('["a","b"]')]).toEqual(["a", "b"]);
    expect(parseDismissedKeys(undefined).size).toBe(0);
    expect(parseDismissedKeys("not json").size).toBe(0);
    expect(parseDismissedKeys('{"a":1}').size).toBe(0);
    expect([...parseDismissedKeys('["a",3,null]')]).toEqual(["a"]);
  });

  it("returns only for a key outside the dismissed set", () => {
    const dismissed = new Set(["a", "b"]);
    expect(hasUndismissedKey(["a", "b"], dismissed)).toBe(false);
    expect(hasUndismissedKey(["a"], dismissed)).toBe(false);
    expect(hasUndismissedKey(["a", "c"], dismissed)).toBe(true);
    expect(hasUndismissedKey(["a"], new Set())).toBe(true);
  });
});
