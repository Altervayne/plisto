import { describe, expect, it } from "vitest";

import { canRetry, canUndo, flowReducer, initialFlow } from "./stampFlow";
import type { FlowAction, FlowState } from "./stampFlow";
import { writtenOf } from "./stampShape";
import type { StampFilePlan, StampPreview, StampSummary, TrackRef } from "../types";

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

function reduce(actions: FlowAction[], from: FlowState = initialFlow): FlowState {
  return actions.reduce(flowReducer, from);
}

const ready = (p = preview()) => reduce([{ type: "previewLoaded", preview: p }]);

const summary = (groups: StampSummary["groups"], over: Partial<StampSummary> = {}): StampSummary => ({
  batchId: 7,
  cancelled: false,
  pointSaved: true,
  groups,
  ...over,
});

describe("a call that returns without a finished event", () => {
  const fileEvents = [
    { kind: "file", index: 0, trackId: 1, outcome: "written" },
    { kind: "file", index: 1, trackId: 2, outcome: "written" },
  ] as const;
  const running = reduce([{ type: "runRequested", runId: 1 }], ready());

  it("settles on the files seen, never back to the confirm", () => {
    const next = reduce([{ type: "settled", runId: 1, events: [...fileEvents], batchId: 12 }], running);
    expect(next.phase).toBe("results");
    expect(next.error).toBeNull();
    expect(next.summary?.batchId).toBe(12);
    expect(writtenOf(next.summary).map((t) => t.trackId)).toEqual([1, 2]);
  });

  it("is replaced by a finished event that arrives late", () => {
    const settled = reduce([{ type: "settled", runId: 1, events: [...fileEvents], batchId: 12 }], running);
    const late = summary([{ outcome: "written", tracks: [ref(1), ref(2)] }, { outcome: "inUse", tracks: [ref(3)] }], {
      batchId: 12,
    });
    const next = flowReducer(settled, { type: "event", runId: 1, event: { kind: "finished", summary: late } });
    expect(next.summary).toBe(late);
    expect(next.provisional).toBeNull();
  });

  it("is ignored once the run has already finished", () => {
    const done = reduce(
      [{ type: "event", runId: 1, event: { kind: "finished", summary: summary([{ outcome: "written", tracks: [ref(1)] }]) } }],
      running,
    );
    expect(flowReducer(done, { type: "settled", runId: 1, events: [], batchId: 1 })).toBe(done);
  });

  it("keeps a rejected call on its own path", () => {
    const next = flowReducer(running, { type: "callFailed", runId: 1, error: "failed" });
    expect(next.phase).toBe("confirm");
  });

  it("settles a retry into the batch and an undo into the undone view", () => {
    const base = reduce([
      { type: "runRequested", runId: 1 },
      { type: "event", runId: 1, event: { kind: "finished", summary: summary([{ outcome: "inUse", tracks: [ref(2)] }, { outcome: "written", tracks: [ref(1)] }]) } },
    ], ready());
    const retried = reduce(
      [{ type: "retryRequested", trackIds: [2], runId: 2 }, { type: "settled", runId: 2, events: [{ kind: "file", index: 0, trackId: 2, outcome: "written" }], batchId: null }],
      base,
    );
    expect(writtenOf(retried.summary).map((t) => t.trackId).sort()).toEqual([1, 2]);
    const undone = reduce(
      [{ type: "undoRequested", runId: 2 }, { type: "settled", runId: 2, events: [{ kind: "file", index: 0, trackId: 1, outcome: "reverted" }], batchId: null }],
      base,
    );
    expect(undone.phase).toBe("undone");
    expect(undone.undone?.groups[0]).toMatchObject({ outcome: "reverted" });
  });
});

describe("batch known", () => {
  const events = [{ kind: "file", index: 0, trackId: 1, outcome: "written" }] as const;
  const running = reduce([{ type: "runRequested", runId: 1 }], ready());

  it("is unknown when a first write settles without a batch id, so Undo and Retry stay hidden", () => {
    const next = flowReducer(running, { type: "settled", runId: 1, events: [...events], batchId: null });
    expect(next.batchKnown).toBe(false);
    expect(canUndo(next)).toBe(false);
    expect(canRetry(next)).toBe(false);
  });

  it("is known once the batch id is read or a finished event arrives", () => {
    const read = flowReducer(running, { type: "settled", runId: 1, events: [...events], batchId: 5 });
    expect(canUndo(read)).toBe(true);
    const late = flowReducer(
      flowReducer(running, { type: "settled", runId: 1, events: [...events], batchId: null }),
      { type: "event", runId: 1, event: { kind: "finished", summary: summary([{ outcome: "written", tracks: [ref(1)] }]) } },
    );
    expect(canUndo(late)).toBe(true);
    expect(canRetry(late)).toBe(true);
  });

  it("leaves the restore point unknown on a summary built from events", () => {
    const next = flowReducer(running, { type: "settled", runId: 1, events: [...events], batchId: 5 });
    expect(next.summary?.pointSaved).toBeNull();
  });
});

describe("run tokens", () => {
  const first = reduce(
    [
      { type: "runRequested", runId: 1 },
      { type: "event", runId: 1, event: { kind: "finished", summary: summary([{ outcome: "inUse", tracks: [ref(2)] }]) } },
    ],
    ready(),
  );
  const settledFirst = reduce(
    [
      { type: "runRequested", runId: 1 },
      { type: "settled", runId: 1, events: [], batchId: 3 },
    ],
    ready(),
  );

  it("drops a late finished event from run 1 while a retry is running", () => {
    const retrying = flowReducer(settledFirst, { type: "retryRequested", trackIds: [2], runId: 2 });
    const late = flowReducer(retrying, {
      type: "event",
      runId: 1,
      event: { kind: "finished", summary: summary([{ outcome: "written", tracks: [ref(9)] }]) },
    });
    expect(late).toBe(retrying);
  });

  it("drops a late finished event from run 1 while an undo is running", () => {
    const undoing = flowReducer(first, { type: "undoRequested", runId: 2 });
    const late = flowReducer(undoing, {
      type: "event",
      runId: 1,
      event: { kind: "finished", summary: summary([]) },
    });
    expect(late).toBe(undoing);
  });

  it("drops a settle that resolves after a new run has started", () => {
    const retrying = flowReducer(first, { type: "retryRequested", trackIds: [2], runId: 2 });
    expect(flowReducer(retrying, { type: "settled", runId: 1, events: [], batchId: 3 })).toBe(retrying);
    expect(flowReducer(retrying, { type: "callFailed", runId: 1, error: "failed" })).toBe(retrying);
  });
});

describe("a bare undo that settles on events", () => {
  const opened = flowReducer(initialFlow, { type: "undoOpened", batchId: 9, files: 2 });
  const undoing = flowReducer(opened, { type: "undoRequested", runId: 4 });

  it("names every file the events carry, from the library lookup", () => {
    const next = flowReducer(undoing, {
      type: "settled",
      runId: 4,
      batchId: null,
      events: [
        { kind: "file", index: 0, trackId: 1, outcome: "reverted" },
        { kind: "file", index: 1, trackId: 2, outcome: "changed" },
      ],
      lookup: (id) => ({ trackId: id, title: `L${id}`, relPath: `p/${id}`, rootLabel: null }),
    });
    expect(next.phase).toBe("undone");
    expect(next.undone?.groups.map((g) => [g.outcome, g.tracks[0].title])).toEqual([
      ["reverted", "L1"],
      ["changed", "L2"],
    ]);
  });

  it("remembers the file in hand while it runs", () => {
    const next = flowReducer(undoing, { type: "event", runId: 4, event: { kind: "file", index: 0, trackId: 7, outcome: "reverted" } });
    expect(next.run).toMatchObject({ written: 1, lastTrackId: 7 });
  });
});

