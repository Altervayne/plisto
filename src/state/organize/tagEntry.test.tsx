// -- Test Imports --
import { beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

// -- Unit Imports --
import { resetTagProposalMemo, useTagEntry, useTagProposals } from "./tagProposals";

// -- Type Imports --
import type { ProjectionState } from "../projectionStatus";
import type { TagEntry, TagProposalSummary } from "./tagProposals";

const h = vi.hoisted(() => ({
  status: "ready" as ProjectionState,
  scanning: false,
  tracks: [] as unknown[],
  loaded: true,
  raw: undefined as string | undefined,
  failed: false,
  albums: [] as unknown[],
  membership: [] as unknown[],
  set: vi.fn(),
}));

vi.mock("../projectionStatus", () => ({ useOrgStatus: () => h.status }));
vi.mock("../store", () => ({
  useAppStore: (select: (s: unknown) => unknown) =>
    select({ scan: { status: h.scanning ? "scanning" : "idle" }, tracks: h.tracks }),
}));
vi.mock("./store", () => ({
  useOrganizeStore: (select: (s: unknown) => unknown) =>
    select({ org: { albums: h.albums, membership: h.membership } }),
}));
vi.mock("../preferences/store", () => ({
  PREF_KEYS: { tagAlbumsDismissed: "tag_albums_dismissed" },
  usePreference: () => h.raw,
  usePreferencesLoaded: () => h.loaded,
  usePreferencesStore: (select: (s: unknown) => unknown) =>
    select({ failedKeys: new Set(h.failed ? ["tag_albums_dismissed"] : []) }),
  useSetPreference: () => h.set,
}));

function loose(id: number, album: string | null, trackNo: number) {
  return {
    id,
    source_path: `/m/${id}.mp3`,
    missing_at: null,
    raw_album: album,
    raw_album_artist: "Artist",
    raw_artist: "Artist",
    raw_track_no: trackNo,
    raw_disc_no: null,
    raw_year: null,
    raw_genre: null,
    album_edit: null,
    album_artist_edit: null,
    artist_edit: null,
    year_edit: null,
    disc_edit: null,
  };
}

const twoAlbums = () => [
  loose(1, "One", 1),
  loose(2, "One", 2),
  loose(3, "Two", 1),
  loose(4, "Two", 2),
  loose(5, null, 1),
];

let proposals: TagProposalSummary | null = null;
let entry: TagEntry | null = null;

function Probe() {
  proposals = useTagProposals();
  entry = useTagEntry();
  return null;
}

const run = () => renderToStaticMarkup(<Probe />);

beforeEach(() => {
  resetTagProposalMemo();
  h.status = "ready";
  h.scanning = false;
  h.tracks = twoAlbums();
  h.loaded = true;
  h.raw = undefined;
  h.failed = false;
  h.albums = [];
  h.membership = [];
  h.set.mockClear();
  proposals = null;
  entry = null;
});

describe("useTagProposals", () => {
  it("counts the albums, their tracks and the loose pile once ready", () => {
    run();
    expect(proposals).toMatchObject({ albumCount: 2, trackCount: 4, looseCount: 5 });
  });

  it("yields nothing until the organization has loaded", () => {
    h.status = "loading";
    run();
    expect(proposals).toBeNull();
    h.status = "stalled";
    run();
    expect(proposals).toBeNull();
  });

  it("yields nothing when no track has album tags", () => {
    h.tracks = [loose(1, null, 1), loose(2, null, 2)];
    run();
    expect(proposals).toBeNull();
  });

  it("holds its last result while a scan runs and regroups when it ends", () => {
    run();
    expect(proposals?.albumCount).toBe(2);
    h.scanning = true;
    h.tracks = [...twoAlbums(), loose(6, "Three", 1), loose(7, "Three", 2)];
    run();
    expect(proposals?.albumCount).toBe(2);
    h.scanning = false;
    run();
    expect(proposals?.albumCount).toBe(3);
  });

  it("regroups mid-scan when a batch is filed", () => {
    run();
    h.scanning = true;
    h.membership = [{ album_id: 99, track_id: 1 }, { album_id: 99, track_id: 2 }];
    run();
    expect(proposals?.albumCount).toBe(1);
  });

  it("groups once when a scan starts before any result was held", () => {
    h.scanning = true;
    run();
    expect(proposals?.albumCount).toBe(2);
  });
});

describe("useTagEntry", () => {
  it("offers the proposals when nothing was dismissed", () => {
    run();
    expect(entry?.summary.albumCount).toBe(2);
  });

  it("offers nothing while the organization is not ready or the preferences are unread", () => {
    h.status = "loading";
    run();
    expect(entry).toBeNull();
    h.status = "ready";
    h.loaded = false;
    run();
    expect(entry).toBeNull();
  });

  it("stays quiet when the dismissal could not be read", () => {
    h.failed = true;
    run();
    expect(entry).toBeNull();
    expect(proposals?.albumCount).toBe(2);
  });

  it("stores the proposal keys on dismiss", () => {
    run();
    entry?.dismiss();
    expect(h.set).toHaveBeenCalledTimes(1);
    const [key, value] = h.set.mock.calls[0] as [string, string];
    expect(key).toBe("tag_albums_dismissed");
    expect(JSON.parse(value)).toEqual(proposals?.keys);
  });

  it("stays hidden while every proposal key is in the dismissed set", () => {
    run();
    h.raw = JSON.stringify(proposals?.keys);
    run();
    expect(entry).toBeNull();
  });

  it("returns once a proposal key appears that was not dismissed", () => {
    run();
    h.raw = JSON.stringify(proposals?.keys);
    h.tracks = [...twoAlbums(), loose(6, "Three", 1), loose(7, "Three", 2)];
    run();
    expect(entry?.summary.albumCount).toBe(3);
  });

  it("stays hidden when proposals only shrink below the dismissed set", () => {
    run();
    h.raw = JSON.stringify(proposals?.keys);
    h.tracks = [loose(1, "One", 1), loose(2, "One", 2)];
    run();
    expect(entry).toBeNull();
  });
});
