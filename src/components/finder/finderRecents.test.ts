// -- Test Imports --
import { describe, expect, it } from "vitest";

// -- Unit Imports --
import { RECENT_LIMIT, parseRecents, pushRecent, resolveRecents } from "./finderRecents";
import { entryKey } from "./finderIndex";

// -- Type Imports --
import type { FinderEntry } from "./finderIndex";

function trackEntry(id: number): FinderEntry {
  return { kind: "track", id, label: `T${id}`, fields: [`t${id}`], trackIds: [id] };
}

// A lookup over the given live entries, as the finder builds from its index.
function lookupOf(entries: FinderEntry[]) {
  const byKey = new Map(entries.map((e) => [entryKey(e.kind, e.id), e] as const));
  return (key: string) => byKey.get(key);
}

describe("parseRecents", () => {
  it("reads a stored list and drops malformed refs", () => {
    const raw = JSON.stringify([
      { kind: "album", id: 3 },
      { kind: "nope", id: 1 },
      { kind: "artist", id: "abba" },
      { id: 4 },
      "junk",
    ]);
    expect(parseRecents(raw)).toEqual([
      { kind: "album", id: 3 },
      { kind: "artist", id: "abba" },
    ]);
  });

  it("falls back to empty on an absent or broken pref", () => {
    expect(parseRecents(undefined)).toEqual([]);
    expect(parseRecents("{not json")).toEqual([]);
    expect(parseRecents('{"kind":"album"}')).toEqual([]);
  });
});

describe("resolveRecents", () => {
  it("drops a ref whose entry no longer exists", () => {
    const lookup = lookupOf([trackEntry(1), trackEntry(3)]);
    const refs = [
      { kind: "track" as const, id: 1 },
      { kind: "track" as const, id: 2 },
      { kind: "track" as const, id: 3 },
    ];
    expect(resolveRecents(refs, lookup).map((e) => e.id)).toEqual([1, 3]);
  });
});

describe("pushRecent", () => {
  it("moves the entry to the front without a duplicate", () => {
    const live = [trackEntry(1), trackEntry(2)];
    const refs = [
      { kind: "track" as const, id: 1 },
      { kind: "track" as const, id: 2 },
    ];
    expect(pushRecent(refs, live[1], lookupOf(live))).toEqual([
      { kind: "track", id: 2 },
      { kind: "track", id: 1 },
    ]);
  });

  it("prunes stale refs and caps the list", () => {
    const live = Array.from({ length: 10 }, (_, i) => trackEntry(i + 1));
    const refs = [
      { kind: "track" as const, id: 99 },
      ...live.slice(0, 8).map((e) => ({ kind: "track" as const, id: e.id })),
    ];
    const next = pushRecent(refs, live[9], lookupOf(live));
    expect(next).toHaveLength(RECENT_LIMIT);
    expect(next[0]).toEqual({ kind: "track", id: 10 });
    expect(next.some((ref) => ref.id === 99)).toBe(false);
  });
});
