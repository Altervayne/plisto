// -- Test Imports --
import { describe, expect, it } from "vitest";

// -- Unit Imports --
import { mergeDelta, mergeRowsById, NO_DELTA, offlineRootIds, summaryFromSync } from "./librarySync";

// -- Type Imports --
import type { TrackRow } from "../types";

const row = (id: number, title = `t${id}`) => ({ id, title }) as unknown as TrackRow;

describe("mergeDelta", () => {
  it("unions ids in arrival order", () => {
    const once = mergeDelta(NO_DELTA, { ids: [3, 1] });
    expect(mergeDelta(once, { ids: [1, 7] })).toEqual({ ids: [3, 1, 7], reload: false });
  });

  it("lets a reload swallow every id, before or after it", () => {
    const reload = mergeDelta({ ids: [1], reload: false }, { reload: true });
    expect(reload).toEqual({ ids: [], reload: true });
    expect(mergeDelta(reload, { ids: [2] })).toEqual({ ids: [], reload: true });
  });
});

describe("mergeRowsById", () => {
  it("replaces rows in place and appends new ids", () => {
    const merged = mergeRowsById([row(1), row(2)], [row(2, "new"), row(5)]);
    expect(merged.map((r) => r.id)).toEqual([1, 2, 5]);
    expect(merged[1]).toMatchObject({ title: "new" });
  });

  it("is idempotent", () => {
    const fresh = [row(2, "new"), row(5)];
    const once = mergeRowsById([row(1), row(2)], fresh);
    expect(mergeRowsById(once, fresh)).toEqual(once);
  });
});

describe("summaryFromSync", () => {
  it("maps the session totals and marks them as a sync summary", () => {
    const s = summaryFromSync({
      inserted: 2,
      updated: 1,
      missing: 3,
      returned: 1,
      deferred: 4,
      errors: 1,
      offline_roots: [9],
    });
    expect(s).toMatchObject({
      source: "sync",
      total: 0,
      seen: 0,
      inserted: 2,
      updated: 1,
      removed: 0,
      missing: 3,
      returned: 1,
      deferred: 4,
      errors: 1,
      cancelled: false,
      offline_roots: [9],
    });
  });
});

describe("offlineRootIds", () => {
  it("flags a root the sync reports offline, or the last summary skipped", () => {
    const states = [
      { id: 1, mode: "watching" as const },
      { id: 2, mode: "offline" as const },
      { id: 3, mode: "polling" as const },
    ];
    expect(offlineRootIds(states, [3]).sort()).toEqual([2, 3]);
    expect(offlineRootIds(states, [])).toEqual([2]);
  });
});
