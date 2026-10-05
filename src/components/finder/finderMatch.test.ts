// -- Test Imports --
import { describe, expect, it } from "vitest";

// -- Unit Imports --
import { TOTAL_CAP, scoreEntry, searchFinder, tokenScore } from "./finderMatch";

// -- Type Imports --
import type { FinderEntry } from "./finderIndex";

const NO_PLAYS = new Map<number, number>();

function trackEntry(id: number, label: string, ...secondary: string[]): FinderEntry {
  return { kind: "track", id, label, fields: [label.toLowerCase(), ...secondary], trackIds: [id] };
}

function albumEntry(id: number, label: string, ...secondary: string[]): FinderEntry {
  return {
    kind: "album",
    id,
    label,
    fields: [label.toLowerCase(), ...secondary],
    trackIds: [],
    count: 0,
  };
}

function labels(entries: FinderEntry[], query: string, plays = NO_PLAYS): string[] {
  return searchFinder([entries], query, plays).groups.flatMap((g) => g.hits.map((h) => h.entry.label));
}

describe("tokenScore", () => {
  it("ranks a prefix over a word start over a substring", () => {
    expect(tokenScore("wall street", "wall")).toBe(3);
    expect(tokenScore("the wall", "wall")).toBe(2);
    expect(tokenScore("drywall", "wall")).toBe(1);
    expect(tokenScore("floor", "wall")).toBe(0);
  });

  it("finds a word start past an earlier mid-word hit", () => {
    expect(tokenScore("drywall wall", "wall")).toBe(2);
    expect(tokenScore("live-wall", "wall")).toBe(2);
  });
});

describe("scoreEntry", () => {
  it("weights a primary hit above the same hit on a secondary field", () => {
    expect(scoreEntry(["blue"], ["blue"])).toBeGreaterThan(scoreEntry(["x", "blue"], ["blue"]));
  });
});

describe("searchFinder", () => {
  it("needs every token to hit some field", () => {
    const entries = [trackEntry(1, "The Wall", "pink floyd")];
    expect(labels(entries, "wall pink")).toEqual(["The Wall"]);
    expect(labels(entries, "wall zeppelin")).toEqual([]);
  });

  it("counts gone tracks that match without showing them", () => {
    const results = searchFinder([[trackEntry(1, "Wall")]], "wall", NO_PLAYS, [
      ["wall", "pink floyd"],
      ["floor"],
    ]);
    expect(results.trackMatches).toBe(2);
    expect(results.groups[0].hits).toHaveLength(1);
  });

  it("returns nothing for a blank query", () => {
    expect(searchFinder([[trackEntry(1, "A")]], " ", NO_PLAYS).groups).toEqual([]);
  });

  it("orders prefix, then word start, then substring", () => {
    const entries = [
      trackEntry(1, "Drywall"),
      trackEntry(2, "The Wall"),
      trackEntry(3, "Wallflower"),
    ];
    expect(labels(entries, "wall")).toEqual(["Wallflower", "The Wall", "Drywall"]);
  });

  it("ranks a title hit above an artist hit", () => {
    const entries = [trackEntry(1, "Other", "blue"), trackEntry(2, "Blue")];
    expect(labels(entries, "blue")).toEqual(["Blue", "Other"]);
  });

  it("breaks ties by recency, then the shorter label, then id", () => {
    const entries = [
      trackEntry(4, "Song Long"),
      trackEntry(3, "Song B"),
      trackEntry(2, "Song A"),
      trackEntry(1, "Song Z"),
    ];
    const plays = new Map([[1, 100]]);
    expect(labels(entries, "song", plays)).toEqual(["Song Z", "Song A", "Song B", "Song Long"]);
  });

  it("puts containers ahead of tracks on a tie", () => {
    const results = searchFinder(
      [[trackEntry(1, "Blue"), albumEntry(2, "Blue")]],
      "blue",
      NO_PLAYS,
    );
    expect(results.groups.map((g) => g.key)).toEqual(["albums", "tracks"]);
  });

  it("orders groups by their best hit", () => {
    const results = searchFinder(
      [[albumEntry(1, "Drywall"), trackEntry(2, "Wall")]],
      "wall",
      NO_PLAYS,
    );
    expect(results.groups.map((g) => g.key)).toEqual(["tracks", "albums"]);
  });

  it("caps each group and the whole list, counting every track match", () => {
    const tracks = Array.from({ length: 14 }, (_, i) => trackEntry(i + 1, `Hit ${i}`));
    const albums = Array.from({ length: 8 }, (_, i) => albumEntry(100 + i, `Hit album ${i}`));
    const results = searchFinder([tracks, albums], "hit", NO_PLAYS);
    const sizes = Object.fromEntries(results.groups.map((g) => [g.key, g.hits.length]));
    expect(sizes).toEqual({ albums: 5, tracks: 10 });
    expect(results.trackMatches).toBe(14);
  });

  it("never renders more than the total cap", () => {
    const kinds = ["artist", "album", "playlist", "genre"] as const;
    const containers: FinderEntry[] = kinds.flatMap((kind, k) =>
      Array.from({ length: 6 }, (_, i) =>
        kind === "artist"
          ? {
              kind,
              id: `x${i}`,
              label: `X ${i}`,
              fields: [`x ${i}`],
              trackIds: [],
              role: "track" as const,
              trackSpellings: [],
              albumSpellings: [],
            }
          : { kind, id: k * 10 + i, label: `X ${i}`, fields: [`x ${i}`], trackIds: [], count: 0 },
      ),
    );
    const tracks = Array.from({ length: 12 }, (_, i) => trackEntry(500 + i, `X t${i}`));
    const destinations: FinderEntry[] = Array.from({ length: 6 }, (_, i) => ({
      kind: "destination",
      id: "home",
      label: `X d${i}`,
      fields: [`x d${i}`],
      trackIds: [],
    }));
    const results = searchFinder([containers, tracks, destinations], "x", NO_PLAYS);
    const total = results.groups.reduce((n, g) => n + g.hits.length, 0);
    expect(total).toBe(TOTAL_CAP);
    // Containers lead on the tie, so the destinations are the ones cut.
    expect(results.groups.map((g) => g.key)).toEqual([
      "artists",
      "albums",
      "playlists",
      "genres",
      "tracks",
    ]);
  });
});
