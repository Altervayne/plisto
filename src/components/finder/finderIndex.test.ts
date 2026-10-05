// -- Test Imports --
import { describe, expect, it } from "vitest";

// -- Unit Imports --
import {
  buildFinderIndex,
  destinationEntries,
  entryKey,
  finderDestinations,
} from "./finderIndex";

// -- Type Imports --
import type { ArtistEntry, FinderSource } from "./finderIndex";
import type { AlbumRow, AlbumTrackRow, TrackRow } from "../../types";

// A minimal row with only the fields the index reads; the rest carry inert defaults.
function track(over: Partial<TrackRow>): TrackRow {
  return {
    id: 1,
    source_path: "",
    filename: "file.flac",
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
    id: 1,
    title: null,
    album_artist: null,
    year: null,
    genre: null,
    cover_id: null,
    kind: "album",
    track_count: 0,
    created_at: 0,
    updated_at: 0,
    ...over,
  };
}

function member(albumId: number, trackId: number, over: Partial<AlbumTrackRow> = {}): AlbumTrackRow {
  return {
    album_id: albumId,
    track_id: trackId,
    source_path: "",
    filename: "",
    duration_secs: null,
    track_no: null,
    disc_no: null,
    raw_title: null,
    raw_artist: null,
    title_override: null,
    artist_override: null,
    has_embedded_cover: null,
    missing_at: null,
    keep_own_cover: false,
    genre_ids: [],
    ...over,
  };
}

function source(over: Partial<FinderSource>): FinderSource {
  return {
    tracks: [],
    albums: [],
    membership: [],
    playlists: [],
    slots: [],
    genres: [],
    untitledAlbum: "Untitled",
    untitledPlaylist: "Untitled playlist",
    ...over,
  };
}

function artists(src: FinderSource): ArtistEntry[] {
  return buildFinderIndex(src).entries.filter((e): e is ArtistEntry => e.kind === "artist");
}

describe("buildFinderIndex artists", () => {
  it("merges spellings on the search fold and shows the most common one", () => {
    const list = artists(
      source({
        tracks: [
          track({ id: 1, raw_artist: "Beyonce" }),
          track({ id: 2, raw_artist: "Beyonc\u00e9" }),
          track({ id: 3, artist_edit: "Beyonc\u00e9", raw_artist: "B" }),
        ],
      }),
    );
    expect(list).toHaveLength(1);
    expect(list[0].label).toBe("Beyonc\u00e9");
    expect(list[0].id).toBe("beyonce");
    expect(list[0].trackSpellings).toEqual(["Beyonce", "Beyonc\u00e9"]);
    expect(list[0].trackIds).toEqual([1, 2, 3]);
  });

  it("records whether the name appears on tracks, albums, or both", () => {
    const list = artists(
      source({
        tracks: [track({ id: 1, raw_artist: "Solo" }), track({ id: 2, raw_artist: "Duo" })],
        albums: [
          album({ id: 10, album_artist: "Duo" }),
          album({ id: 11, album_artist: "Various Artists" }),
        ],
      }),
    );
    const role = Object.fromEntries(list.map((a) => [a.label, a.role]));
    expect(role).toEqual({ Solo: "track", Duo: "both", "Various Artists": "album" });
    const various = list.find((a) => a.label === "Various Artists");
    expect(various?.albumSpellings).toEqual(["Various Artists"]);
    expect(various?.trackSpellings).toEqual([]);
  });

  it("breaks a spelling tie the same way every time", () => {
    const list = artists(
      source({ tracks: [track({ id: 1, raw_artist: "abba" }), track({ id: 2, raw_artist: "ABBA" })] }),
    );
    expect(list[0].label).toBe("ABBA");
  });
});

describe("buildFinderIndex tracks", () => {
  it("leaves out a track gone from disk, and its artist with it", () => {
    const index = buildFinderIndex(
      source({
        tracks: [
          track({ id: 1, raw_title: "Here", raw_artist: "Kept" }),
          track({ id: 2, raw_title: "Gone", raw_artist: "Lost", missing_at: 5 }),
        ],
      }),
    );
    expect(index.byKey.has(entryKey("track", 1))).toBe(true);
    expect(index.byKey.has(entryKey("track", 2))).toBe(false);
    expect(index.byKey.has(entryKey("artist", "lost"))).toBe(false);
  });

  it("folds the effective title first, then the artist, the resolved album and the filename", () => {
    const index = buildFinderIndex(
      source({
        tracks: [
          track({ id: 1, raw_title: "Raw", title_edit: "\u00c9t\u00e9", raw_artist: "A", raw_album: "Tag" }),
        ],
        albums: [album({ id: 9, title: "Filed" })],
        membership: [member(9, 1)],
      }),
    );
    const entry = index.byKey.get(entryKey("track", 1));
    expect(entry?.label).toBe("\u00c9t\u00e9");
    expect(entry?.fields).toEqual(["ete", "a", "filed", "file.flac"]);
  });

  it("falls back to the filename for an untitled track", () => {
    const index = buildFinderIndex(source({ tracks: [track({ id: 1, filename: "Take 3.wav" })] }));
    expect(index.byKey.get(entryKey("track", 1))?.label).toBe("Take 3.wav");
  });
});

describe("buildFinderIndex containers", () => {
  it("splits albums from singles and queues members in drawer order", () => {
    const index = buildFinderIndex(
      source({
        albums: [
          album({ id: 1, title: "Record", album_artist: "Band" }),
          album({ id: 2, title: null, kind: "single" }),
        ],
        membership: [
          member(1, 30, { disc_no: 2, track_no: 1 }),
          member(1, 10, { disc_no: 1, track_no: 2 }),
          member(1, 20, { disc_no: 1, track_no: 1 }),
        ],
      }),
    );
    const record = index.byKey.get(entryKey("album", 1));
    expect(record?.trackIds).toEqual([20, 10, 30]);
    expect(record?.fields).toEqual(["record", "band"]);
    expect(index.byKey.get(entryKey("single", 2))?.label).toBe("Untitled");
  });
});

describe("finderDestinations", () => {
  it("keeps Home, the visible rows, and Settings", () => {
    const organizer = finderDestinations("organizer");
    expect(organizer[0]).toBe("home");
    expect(organizer[organizer.length - 1]).toBe("settings");
    expect(organizer).not.toContain("player");
    expect(finderDestinations("player")).not.toContain("export");
  });

  it("folds the label as the only field", () => {
    expect(destinationEntries([{ mode: "settings", label: "R\u00e9glages" }])[0].fields).toEqual([
      "reglages",
    ]);
  });
});
