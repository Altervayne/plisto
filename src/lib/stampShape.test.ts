import { describe, expect, it } from "vitest";

import {
  buildResults,
  buildUndone,
  describeScope,
  fieldsPresent,
  groupByChange,
  groupByRoot,
  isRetryable,
  mergeRetry,
  orderedSkips,
  summaryFromEvents,
} from "./stampShape";
import type { FlowSummary } from "./stampShape";
import type { AlbumRow, StampFilePlan, StampPreview, StampSummary, TrackRef } from "../types";

const ref = (id: number): TrackRef => ({ trackId: id, title: `T${id}`, relPath: `a/${id}.flac`, rootLabel: null });
const plan = (id: number, changes: StampFilePlan["changes"]): StampFilePlan => ({
  trackId: id,
  title: `T${id}`,
  relPath: `a/${id}.flac`,
  changes,
});

function preview(over: Partial<StampPreview> = {}): StampPreview {
  return {
    previewId: "p1",
    files: [plan(1, [{ field: "album", from: null, to: "X" }]), plan(2, [{ field: "album", from: "x", to: "X" }])],
    skips: [{ reason: "unchanged", tracks: [ref(3)] }],
    exportRunning: false,
    exportsAffected: 0,
    ...over,
  };
}

const summary = (groups: StampSummary["groups"], over: Partial<StampSummary> = {}): StampSummary => ({
  batchId: 7,
  cancelled: false,
  pointSaved: true,
  groups,
  ...over,
});

describe("mergeRetry", () => {
  it("is the same whether the retry reports the whole batch or only its files", () => {
    const prev = summary([
      { outcome: "written", tracks: [ref(1)] },
      { outcome: "inUse", tracks: [ref(2)] },
    ]);
    const only = mergeRetry(prev, summary([{ outcome: "written", tracks: [ref(2)] }]), [2]);
    const whole = mergeRetry(prev, summary([{ outcome: "written", tracks: [ref(1), ref(2)] }]), [2]);
    const ids = (s: FlowSummary) => s.groups.flatMap((g) => g.tracks.map((t) => t.trackId)).sort();
    expect(ids(only)).toEqual([1, 2]);
    expect(ids(whole)).toEqual([1, 2]);
    expect(whole.groups).toHaveLength(1);
  });
});

describe("grouping", () => {
  it("lists skip reasons in display order and counts them", () => {
    const view = buildResults(
      summary([
        { outcome: "unchanged", tracks: [ref(3)] },
        { outcome: "comment", tracks: [ref(4)] },
        { outcome: "edited", tracks: [ref(6)] },
        { outcome: "inUse", tracks: [ref(5)] },
        { outcome: "written", tracks: [ref(1)] },
      ]),
      null,
    );
    expect(view.skipped.map((g) => g.outcome)).toEqual(["inUse", "comment", "edited", "unchanged"]);
    expect(view.skippedCount).toBe(4);
  });

  it("names the files a stop left unstarted", () => {
    const view = buildResults(
      summary([{ outcome: "written", tracks: [ref(1)] }], { cancelled: true }),
      preview(),
    );
    expect(view.notStarted.map((t) => t.trackId)).toEqual([2]);
  });

  it("lists no unstarted files when the batch was not stopped", () => {
    expect(buildResults(summary([{ outcome: "written", tracks: [ref(1)] }]), preview()).notStarted).toEqual([]);
  });

  it("splits an undo into reverted and kept groups", () => {
    const view = buildUndone(
      summary([
        { outcome: "reverted", tracks: [ref(1), ref(2)] },
        { outcome: "changed", tracks: [ref(3)] },
      ]),
    );
    expect(view.reverted).toHaveLength(2);
    expect(view.kept.map((g) => g.outcome)).toEqual(["changed"]);
    expect(view.keptCount).toBe(1);
  });

  it("offers Retry for in-use and failed only", () => {
    expect(isRetryable("inUse")).toBe(true);
    expect(isRetryable("failed")).toBe(true);
    expect(isRetryable("readOnly")).toBe(false);
    expect(isRetryable("edited")).toBe(false);
  });

  it("orders the preview's skips", () => {
    const groups = orderedSkips(
      preview({
        skips: [
          { reason: "unchanged", tracks: [ref(3)] },
          { reason: "edited", tracks: [ref(4)] },
          { reason: "readOnly", tracks: [] },
        ],
      }),
    );
    expect(groups.map((g) => g.outcome)).toEqual(["edited", "unchanged"]);
  });
});

describe("the diff", () => {
  const files = [
    plan(1, [
      { field: "year", from: null, to: "2019" },
      { field: "album", from: "salt", to: "Salt" },
    ]),
    plan(2, [{ field: "album", from: "salt", to: "Salt" }]),
    plan(3, [{ field: "title", from: "a", to: "A" }]),
  ];

  it("groups identical changes, in field order", () => {
    const { rows, hiddenFiles } = groupByChange(files);
    expect(rows.map((r) => [r.field, r.files.length])).toEqual([
      ["title", 1],
      ["album", 2],
      ["year", 1],
    ]);
    expect(hiddenFiles).toBe(0);
  });

  it("keeps an empty value apart from the same text", () => {
    const { rows } = groupByChange([
      plan(1, [{ field: "year", from: null, to: "1" }]),
      plan(2, [{ field: "year", from: "", to: "1" }]),
    ]);
    expect(rows).toHaveLength(2);
  });

  it("counts the files of the rows past the limit", () => {
    const { rows, hiddenFiles } = groupByChange(files, 2);
    expect(rows).toHaveLength(2);
    expect(hiddenFiles).toBe(1);
  });

  it("reports which fields are touched", () => {
    expect([...fieldsPresent(files)].sort()).toEqual(["album", "title", "year"]);
  });
});

describe("describeScope", () => {
  const album = (id: number, kind: AlbumRow["kind"], title: string): AlbumRow => ({
    id,
    title,
    album_artist: "Artist",
    year: null,
    genre: null,
    cover_id: null,
    kind,
    track_count: 11,
    created_at: 0,
    updated_at: 0,
  });
  const salt = album(1, "album", "Salt");
  const wire = album(2, "single", "Wire");
  const homes = new Map<number, AlbumRow>([
    [10, salt],
    [11, salt],
    [20, wire],
  ]);

  it("names a whole album, a single and the library", () => {
    expect(describeScope({ kind: "albums", albumIds: [1] }, [salt, wire], homes, 99)).toEqual({
      kind: "album",
      title: "Salt",
      artist: "Artist",
      tracks: 11,
    });
    expect(describeScope({ kind: "albums", albumIds: [2] }, [salt, wire], homes, 99).kind).toBe("single");
    expect(describeScope({ kind: "albums", albumIds: [1, 2] }, [salt, wire], homes, 99)).toEqual({ kind: "albums", n: 2 });
    expect(describeScope({ kind: "library" }, [], homes, 99)).toEqual({ kind: "library", tracks: 99 });
  });

  it("names a selection by where its tracks are filed", () => {
    expect(describeScope({ kind: "tracks", trackIds: [10, 11] }, [salt], homes, 0)).toEqual({
      kind: "selection",
      album: "Salt",
      n: 2,
    });
    expect(describeScope({ kind: "tracks", trackIds: [20] }, [wire], homes, 0).kind).toBe("single");
    expect(describeScope({ kind: "tracks", trackIds: [90, 91] }, [salt], homes, 0)).toEqual({ kind: "loose", n: 2 });
    expect(describeScope({ kind: "tracks", trackIds: [10, 90] }, [salt], homes, 0)).toEqual({ kind: "count", n: 2 });
  });
});

describe("groupByRoot", () => {
  it("counts per folder and pools unnamed files", () => {
    const at = (id: number, rootLabel: string | null): TrackRef => ({ ...ref(id), rootLabel });
    expect(groupByRoot([at(1, "E:\Archive"), at(2, "E:\Archive"), at(3, null)])).toEqual([
      { label: "E:\Archive", count: 2 },
      { label: null, count: 1 },
    ]);
  });
});


describe("summaryFromEvents", () => {
  const file = (id: number, outcome: "written" | "inUse") =>
    ({ kind: "file", index: id, trackId: id, outcome }) as const;

  it("groups the seen files and keeps the files the preview left alone", () => {
    const built = summaryFromEvents({
      batchId: 4,
      cancelled: true,
      preview: preview(),
      known: [],
      events: [{ kind: "started", total: 2 }, file(1, "written"), file(2, "inUse")],
    });
    const ids = (outcome: string) => built.groups.find((g) => g.outcome === outcome)?.tracks.map((t) => t.trackId);
    expect(ids("written")).toEqual([1]);
    expect(ids("inUse")).toEqual([2]);
    expect(ids("unchanged")).toEqual([3]);
    expect(built).toMatchObject({ batchId: 4, cancelled: true });
  });

  it("names the files of a retry from the known tracks", () => {
    const built = summaryFromEvents({
      batchId: 4,
      cancelled: false,
      preview: null,
      known: [ref(5)],
      events: [file(5, "written")],
    });
    expect(built.groups).toEqual([{ outcome: "written", tracks: [ref(5)] }]);
  });
});
