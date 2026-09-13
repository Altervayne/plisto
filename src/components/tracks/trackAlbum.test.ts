// -- Test Imports --
import { describe, expect, it } from "vitest";

// -- Unit Imports --
import {
  buildAlbumIndex,
  isSingleMember,
  resolveTrackAlbum,
  resolveTrackAlbumArtist,
  resolveTrackYear,
} from "./trackAlbum";

// -- Type Imports --
import type { AlbumRow, AlbumTrackRow, TrackRow } from "../../types";

// A minimal track carrying only the fields the resolvers read; the rest take inert defaults.
function row(over: Partial<TrackRow>): TrackRow {
  return {
    id: 1,
    source_path: "",
    filename: "",
    ext: "flac",
    size_bytes: 0,
    mtime: 0,
    duration_secs: null,
    raw_title: null,
    raw_artist: null,
    raw_album: null,
    raw_album_artist: null,
    raw_track_no: null,
    raw_disc_no: null,
    raw_year: null,
    raw_genre: null,
    scanned_at: 0,
    missing_at: null,
    display_path: null,
    title_edit: null,
    artist_edit: null,
    album_edit: null,
    album_artist_edit: null,
    year_edit: null,
    disc_edit: null,
    genre_ids: [],
    ...over,
  };
}

function album(over: Partial<AlbumRow>): AlbumRow {
  return {
    id: 100,
    title: "A Title",
    album_artist: "An Artist",
    year: 1990,
    genre: null,
    cover_id: null,
    kind: "album",
    track_count: 0,
    created_at: 0,
    updated_at: 0,
    ...over,
  };
}

function member(albumId: number, trackId: number): AlbumTrackRow {
  return {
    album_id: albumId,
    track_id: trackId,
    source_path: "",
    filename: "",
    duration_secs: null,
    track_no: 1,
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

// An index holding one track filed into one album.
function indexOf(trackId: number, a: AlbumRow): Map<number, AlbumRow> {
  return buildAlbumIndex([member(a.id, trackId)], [a]);
}

describe("buildAlbumIndex", () => {
  it("maps each membership row's track to its album, across both kinds", () => {
    const real = album({ id: 1, kind: "album" });
    const single = album({ id: 2, kind: "single" });
    const index = buildAlbumIndex(
      [member(1, 10), member(2, 20)],
      [real, single],
    );
    expect(index.get(10)).toBe(real);
    expect(index.get(20)).toBe(single);
    expect(index.get(30)).toBeUndefined();
  });

  it("drops a membership row whose album is absent", () => {
    const index = buildAlbumIndex([member(99, 10)], [album({ id: 1 })]);
    expect(index.get(10)).toBeUndefined();
  });
});

describe("resolveTrackAlbum", () => {
  it("inherits a real album's title, ignoring the stale raw tag", () => {
    const track = row({ id: 10, raw_album: "Stale tag" });
    const index = indexOf(10, album({ id: 1, title: "Kind of Blue" }));
    expect(resolveTrackAlbum(track, index)).toBe("Kind of Blue");
  });

  it("ignores a per-track edit for a real-album member, the album is authoritative", () => {
    const track = row({ id: 10, album_edit: "Renamed", raw_album: "Stale tag" });
    const index = indexOf(10, album({ id: 1, title: "Kind of Blue" }));
    expect(resolveTrackAlbum(track, index)).toBe("Kind of Blue");
  });

  it("resolves a single member inheriting its title", () => {
    const track = row({ id: 10, raw_album: "Stale tag" });
    const index = indexOf(10, album({ id: 1, kind: "single", title: "One Cut" }));
    expect(resolveTrackAlbum(track, index)).toBe("One Cut");
  });

  it("lets a single member's edit win over its single's title", () => {
    const track = row({ id: 10, album_edit: "Renamed", raw_album: "Stale tag" });
    const index = indexOf(10, album({ id: 1, kind: "single", title: "One Cut" }));
    expect(resolveTrackAlbum(track, index)).toBe("Renamed");
  });

  it("folds an untitled album member to null, hiding the raw tag", () => {
    const track = row({ id: 10, raw_album: "Stale tag" });
    const index = indexOf(10, album({ id: 1, title: null }));
    expect(resolveTrackAlbum(track, index)).toBeNull();
  });

  it("reads a loose track edit over its raw tag", () => {
    expect(resolveTrackAlbum(row({ raw_album: "Aja" }), new Map())).toBe("Aja");
    expect(resolveTrackAlbum(row({ raw_album: "Aja", album_edit: "Gaucho" }), new Map())).toBe(
      "Gaucho",
    );
    expect(resolveTrackAlbum(row({ raw_album: null }), new Map())).toBeNull();
  });
});

describe("resolveTrackAlbumArtist", () => {
  it("takes a real album's album-artist outright, ignoring a per-track edit", () => {
    const track = row({ id: 10, raw_album_artist: "Stale" });
    const index = indexOf(10, album({ id: 1, album_artist: "Miles Davis" }));
    expect(resolveTrackAlbumArtist(track, index)).toBe("Miles Davis");
    const edited = row({ id: 10, album_artist_edit: "Sextet", raw_album_artist: "Stale" });
    expect(resolveTrackAlbumArtist(edited, index)).toBe("Miles Davis");
  });

  it("lets a single member's edit win over its single's album-artist", () => {
    const index = indexOf(10, album({ id: 1, kind: "single", album_artist: "Miles Davis" }));
    const edited = row({ id: 10, album_artist_edit: "Sextet" });
    expect(resolveTrackAlbumArtist(edited, index)).toBe("Sextet");
  });

  it("reads a loose track edit over its raw tag", () => {
    expect(resolveTrackAlbumArtist(row({ raw_album_artist: "VA" }), new Map())).toBe("VA");
    expect(resolveTrackAlbumArtist(row({ raw_album_artist: null }), new Map())).toBeNull();
  });
});

describe("resolveTrackYear", () => {
  it("takes a real album's year as a string outright, ignoring a per-track edit", () => {
    const track = row({ id: 10, raw_year: 1900 });
    const index = indexOf(10, album({ id: 1, year: 1959 }));
    expect(resolveTrackYear(track, index)).toBe("1959");
    const edited = row({ id: 10, year_edit: 1997, raw_year: 1900 });
    expect(resolveTrackYear(edited, index)).toBe("1959");
  });

  it("lets a single member's edit win over its single's year", () => {
    const index = indexOf(10, album({ id: 1, kind: "single", year: 1959 }));
    const edited = row({ id: 10, year_edit: 1997 });
    expect(resolveTrackYear(edited, index)).toBe("1997");
  });

  it("folds a yearless album member to null", () => {
    const track = row({ id: 10, raw_year: 1900 });
    const index = indexOf(10, album({ id: 1, year: null }));
    expect(resolveTrackYear(track, index)).toBeNull();
  });

  it("reads a loose track edit over its raw tag", () => {
    expect(resolveTrackYear(row({ raw_year: 1971 }), new Map())).toBe("1971");
    expect(resolveTrackYear(row({ raw_year: 1971, year_edit: 1980 }), new Map())).toBe("1980");
    expect(resolveTrackYear(row({ raw_year: null }), new Map())).toBeNull();
  });
});

describe("isSingleMember", () => {
  it("is true only for a member of a single", () => {
    const single = indexOf(10, album({ id: 1, kind: "single" }));
    const real = indexOf(20, album({ id: 2, kind: "album" }));
    expect(isSingleMember(row({ id: 10 }), single)).toBe(true);
    expect(isSingleMember(row({ id: 20 }), real)).toBe(false);
    expect(isSingleMember(row({ id: 30 }), new Map())).toBe(false);
  });
});
