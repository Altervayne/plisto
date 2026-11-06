// -- Test Imports --
import { describe, expect, it } from "vitest";

// -- Unit Imports --
import {
  resolveSegment,
  segmentViews,
  switchShows,
  visibleSegments,
} from "./collectionSegments";
import type { CollectionSegment } from "../../state/collection/store";
import type { AppMode } from "../../state/player/store";

const ALL: CollectionSegment[] = ["browse", "albums", "singles", "tracks"];

// A rule no current mode uses: Player drops All tracks, so the fallback has something to fall from.
const HIDING: Record<AppMode, ReadonlySet<CollectionSegment>> = {
  both: new Set(),
  player: new Set(["tracks"]),
  organizer: new Set(),
};

describe("visibleSegments", () => {
  it("keeps all four segments in every mode", () => {
    for (const mode of ["both", "player", "organizer"] as AppMode[]) {
      expect(visibleSegments(mode)).toEqual(ALL);
    }
  });

  it("drops what an injected rule hides, keeping the order", () => {
    expect(visibleSegments("player", HIDING)).toEqual(["browse", "albums", "singles"]);
    expect(visibleSegments("both", HIDING)).toEqual(ALL);
  });
});

describe("segmentViews", () => {
  it("counts every segment but Browse", () => {
    const views = segmentViews(ALL, { albums: 12, singles: 3, tracks: 240 });
    expect(views.map((v) => v.count)).toEqual([null, 12, 3, 240]);
    expect(views.some((v) => v.dimmed)).toBe(false);
  });

  it("dims an empty Singles and keeps it in place", () => {
    const views = segmentViews(ALL, { albums: 12, singles: 0, tracks: 240 });
    expect(views.map((v) => v.id)).toEqual(ALL);
    expect(views.find((v) => v.id === "singles")?.dimmed).toBe(true);
  });

  it("never dims an empty Albums or All tracks", () => {
    const views = segmentViews(ALL, { albums: 0, singles: 5, tracks: 0 });
    expect(views.filter((v) => v.dimmed)).toEqual([]);
  });
});

describe("switchShows", () => {
  it("hides the switch with one segment left", () => {
    expect(switchShows(["albums"])).toBe(false);
    expect(switchShows(["albums", "singles"])).toBe(true);
  });
});

describe("resolveSegment", () => {
  it("lands on Albums on first run", () => {
    expect(resolveSegment(undefined, ALL)).toBe("albums");
  });

  it("keeps a remembered segment that still shows", () => {
    expect(resolveSegment("browse", ALL)).toBe("browse");
    expect(resolveSegment("singles", ALL)).toBe("singles");
    expect(resolveSegment("tracks", ALL)).toBe("tracks");
  });

  it("falls back to Albums from an unknown stored value", () => {
    expect(resolveSegment("covers", ALL)).toBe("albums");
    expect(resolveSegment("", ALL)).toBe("albums");
  });

  it("falls back to Albums when the mode hides the remembered segment", () => {
    expect(resolveSegment("tracks", visibleSegments("player", HIDING))).toBe("albums");
    expect(resolveSegment("tracks", visibleSegments("both", HIDING))).toBe("tracks");
  });

  it("takes the first shown segment when Albums itself is hidden", () => {
    expect(resolveSegment("tracks", ["browse", "singles"])).toBe("browse");
  });
});
