// -- Test Imports --
import { describe, expect, it } from "vitest";

// -- Unit Imports --
import {
  breadcrumb,
  childFolders,
  descendantTracks,
  foldId,
  immediateTracks,
  isLibraryScope,
  LIBRARY_SCOPE,
  libraryBreadcrumb,
  parentId,
  rootFolders,
} from "./folderTree";

// -- Type Imports --
import type { Root, TrackRow } from "../../types";

// A scanned row with only the fields the tree reads. source_path is the folded identity, as the
// backend stores it; display_path is the real-case path, or null before a scan drains it.
function track(id: number, source: string, display: string | null): TrackRow {
  return {
    id,
    source_path: source,
    filename: source.split(/[\\/]/).pop() ?? "",
    ext: "mp3",
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
    display_path: display,
    title_edit: null,
    artist_edit: null,
    album_edit: null,
    album_artist_edit: null,
    year_edit: null,
    disc_edit: null,
    genre_ids: [],
  };
}

// A library root: real-case path plus the count the backend reports (unused by the tree engine).
function root(id: number, path: string): Root {
  return { id, path, track_count: 0 };
}

describe("foldId", () => {
  it("lowercases, unifies slashes, and drops a trailing slash", () => {
    expect(foldId("F:\\Music\\Lib\\")).toBe("f:/music/lib");
    expect(foldId("f:/music/lib")).toBe("f:/music/lib");
  });
});

describe("childFolders", () => {
  it("groups Windows backslash paths and folds case into one folder", () => {
    const tracks = [
      track(1, "f:\\music\\lib\\artist\\album\\01.mp3", "F:\\Music\\Lib\\Artist\\Album\\01.mp3"),
      track(2, "f:\\music\\lib\\ARTIST\\album\\02.mp3", "F:\\Music\\Lib\\ARTIST\\Album\\02.mp3"),
    ];
    const folders = childFolders(tracks, "f:/music/lib");
    expect(folders).toHaveLength(1);
    expect(folders[0].id).toBe("f:/music/lib/artist");
    expect(folders[0].trackCount).toBe(2);
  });

  it("makes no folder node for a lone top-level file", () => {
    const tracks = [
      track(1, "f:\\music\\lib\\loose.mp3", "F:\\Music\\Lib\\loose.mp3"),
      track(2, "f:\\music\\lib\\artist\\01.mp3", "F:\\Music\\Lib\\Artist\\01.mp3"),
    ];
    const folders = childFolders(tracks, "f:/music/lib");
    expect(folders.map((f) => f.name)).toEqual(["Artist"]);
  });

  it("rolls up descendant counts and counts only immediate subfolders", () => {
    const tracks = [
      track(1, "f:\\m\\lib\\artist\\a\\01.mp3", "F:\\M\\Lib\\Artist\\A\\01.mp3"),
      track(2, "f:\\m\\lib\\artist\\a\\02.mp3", "F:\\M\\Lib\\Artist\\A\\02.mp3"),
      track(3, "f:\\m\\lib\\artist\\b\\03.mp3", "F:\\M\\Lib\\Artist\\B\\03.mp3"),
    ];
    const folders = childFolders(tracks, "f:/m/lib");
    expect(folders).toHaveLength(1);
    expect(folders[0].trackCount).toBe(3);
    expect(folders[0].subfolderCount).toBe(2);
  });

  it("takes the real-case name from display_path, and falls back when it is null", () => {
    const real = childFolders(
      [track(1, "f:\\m\\lib\\artist\\01.mp3", "F:\\M\\Lib\\ArTiSt\\01.mp3")],
      "f:/m/lib",
    );
    expect(real[0].name).toBe("ArTiSt");

    const folded = childFolders(
      [track(1, "f:\\m\\lib\\artist\\01.mp3", null)],
      "f:/m/lib",
    );
    expect(folded[0].name).toBe("artist");
  });

  it("groups forward-slash paths the same way", () => {
    const tracks = [
      track(1, "/music/lib/artist/album/01.mp3", "/music/lib/Artist/Album/01.mp3"),
      track(2, "/music/lib/artist/album/02.mp3", "/music/lib/Artist/Album/02.mp3"),
    ];
    const folders = childFolders(tracks, "/music/lib");
    expect(folders).toHaveLength(1);
    expect(folders[0].name).toBe("Artist");
    expect(folders[0].trackCount).toBe(2);
  });
});

describe("immediateTracks vs descendantTracks", () => {
  const tracks = [
    track(1, "f:\\m\\lib\\artist\\album\\01.mp3", "F:\\M\\Lib\\Artist\\Album\\01.mp3"),
    track(2, "f:\\m\\lib\\loose.mp3", "F:\\M\\Lib\\loose.mp3"),
  ];

  it("counts a two-level-deep track as descendant only, not immediate", () => {
    expect(immediateTracks(tracks, "f:/m/lib").map((t) => t.id)).toEqual([2]);
    expect(descendantTracks(tracks, "f:/m/lib").map((t) => t.id)).toEqual([1, 2]);
  });

  it("surfaces the intervening folder with the rolled-up count", () => {
    const folders = childFolders(tracks, "f:/m/lib");
    expect(folders).toHaveLength(1);
    expect(folders[0].name).toBe("Artist");
    expect(folders[0].trackCount).toBe(1);
    expect(folders[0].subfolderCount).toBe(1);
  });
});

describe("breadcrumb", () => {
  it("runs from the real-case root down to the scope, inclusive", () => {
    const tracks = [
      track(1, "f:\\music\\lib\\artist\\album\\01.mp3", "F:\\Music\\Lib\\Artist\\Album\\01.mp3"),
    ];
    const crumbs = breadcrumb(tracks, "f:/music/lib", "f:/music/lib/artist/album");
    expect(crumbs.map((c) => c.name)).toEqual(["Lib", "Artist", "Album"]);
    expect(crumbs.map((c) => c.id)).toEqual([
      "f:/music/lib",
      "f:/music/lib/artist",
      "f:/music/lib/artist/album",
    ]);
  });

  it("is a single crumb at the root", () => {
    const tracks = [track(1, "f:\\music\\lib\\01.mp3", "F:\\Music\\Lib\\01.mp3")];
    const crumbs = breadcrumb(tracks, "f:/music/lib", "f:/music/lib");
    expect(crumbs).toHaveLength(1);
    expect(crumbs[0].name).toBe("Lib");
  });
});

describe("parentId", () => {
  it("drops the last segment, and a filesystem root maps to itself", () => {
    expect(parentId("f:/music/lib/artist")).toBe("f:/music/lib");
    expect(parentId("/music")).toBe("/");
    expect(parentId("f:")).toBe("f:");
  });
});

describe("rootFolders", () => {
  const roots = [root(1, "F:\\Mobile Music"), root(2, "D:\\Archive")];
  const tracks = [
    track(1, "f:\\mobile music\\artist\\01.mp3", "F:\\Mobile Music\\Artist\\01.mp3"),
    track(2, "f:\\mobile music\\artist\\02.mp3", "F:\\Mobile Music\\Artist\\02.mp3"),
    track(3, "f:\\mobile music\\loose.mp3", "F:\\Mobile Music\\loose.mp3"),
    track(4, "d:\\archive\\old\\03.mp3", "D:\\Archive\\Old\\03.mp3"),
  ];

  it("makes one node per root with its rolled-up count and immediate subfolders", () => {
    const nodes = rootFolders(tracks, roots);
    const mobile = nodes.find((n) => n.id === "f:/mobile music");
    const archive = nodes.find((n) => n.id === "d:/archive");
    expect(mobile).toMatchObject({ name: "Mobile Music", trackCount: 3, subfolderCount: 1 });
    expect(archive).toMatchObject({ name: "Archive", trackCount: 1, subfolderCount: 1 });
  });

  it("sorts the roots by name, case-insensitive", () => {
    expect(rootFolders(tracks, roots).map((n) => n.name)).toEqual(["Archive", "Mobile Music"]);
  });

  it("names an empty root from its own path, not a descendant", () => {
    const nodes = rootFolders([], [root(1, "F:\\Mobile Music")]);
    expect(nodes[0]).toMatchObject({ name: "Mobile Music", trackCount: 0, subfolderCount: 0 });
  });

  it("keeps a root's tracks reachable through its node and after drilling in", () => {
    const bNode = rootFolders(tracks, roots).find((n) => n.id === "d:/archive");
    expect(bNode?.trackCount).toBe(1);
    // Drilling to root B, the existing prefix engine surfaces its subfolder and its track.
    expect(childFolders(tracks, "d:/archive").map((f) => f.name)).toEqual(["Old"]);
    expect(descendantTracks(tracks, "d:/archive").map((t) => t.id)).toEqual([4]);
  });
});

describe("libraryBreadcrumb", () => {
  const roots = [root(1, "F:\\Mobile Music"), root(2, "D:\\Archive")];
  const tracks = [
    track(1, "f:\\mobile music\\artist\\album\\01.mp3", "F:\\Mobile Music\\Artist\\Album\\01.mp3"),
    track(2, "d:\\archive\\03.mp3", "D:\\Archive\\03.mp3"),
  ];

  it("is a single Library crumb at the library level", () => {
    const crumbs = libraryBreadcrumb(tracks, roots, LIBRARY_SCOPE, "Library");
    expect(crumbs.map((c) => c.name)).toEqual(["Library"]);
    expect(crumbs[0].id).toBe(LIBRARY_SCOPE);
  });

  it("heads the chain with Library then the root at a root scope", () => {
    const crumbs = libraryBreadcrumb(tracks, roots, "f:/mobile music", "Library");
    expect(crumbs.map((c) => c.name)).toEqual(["Library", "Mobile Music"]);
    expect(crumbs.map((c) => c.id)).toEqual([LIBRARY_SCOPE, "f:/mobile music"]);
  });

  it("runs Library through the containing root down to a deep scope", () => {
    const crumbs = libraryBreadcrumb(tracks, roots, "f:/mobile music/artist/album", "Library");
    expect(crumbs.map((c) => c.name)).toEqual(["Library", "Mobile Music", "Artist", "Album"]);
  });

  it("keeps a single root anchored with no Library crumb", () => {
    const one = [root(1, "F:\\Mobile Music")];
    const crumbs = libraryBreadcrumb(tracks, one, "f:/mobile music/artist", "Library");
    expect(crumbs.map((c) => c.name)).toEqual(["Mobile Music", "Artist"]);
  });
});

describe("isLibraryScope", () => {
  it("holds for the sentinel and never for a real folded path", () => {
    expect(isLibraryScope(LIBRARY_SCOPE)).toBe(true);
    expect(isLibraryScope("f:/mobile music")).toBe(false);
  });
});
