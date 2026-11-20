import { describe, expect, it } from "vitest";

import { canWrite, flowReducer, initialFlow } from "./stampFlow";
import type { FlowAction, FlowState } from "./stampFlow";
import { buildResults, writtenOf } from "./stampShape";
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

describe("confirm", () => {
  it("is not writable while the preview loads or has failed", () => {
    expect(canWrite(initialFlow)).toBe(false);
    expect(canWrite(reduce([{ type: "previewFailed" }]))).toBe(false);
  });

  it("is writable once ready", () => {
    expect(canWrite(ready())).toBe(true);
  });

  it("refuses to run while an export runs, or with nothing to write", () => {
    expect(canWrite(ready(preview({ exportRunning: true })))).toBe(false);
    const blocked = reduce([{ type: "runRequested", runId: 1 }], ready(preview({ exportRunning: true })));
    expect(blocked.phase).toBe("confirm");
    expect(canWrite(ready(preview({ files: [] })))).toBe(false);
  });
});

describe("a write", () => {
  const started = reduce([{ type: "runRequested", runId: 1 }], ready());

  it("starts with the preview's skips already counted", () => {
    expect(started.phase).toBe("running");
    expect(started.run).toMatchObject({ total: 2, done: 0, skipped: 1, written: 0 });
  });

  it("folds file events into the counters", () => {
    const next = reduce(
      [
        { type: "event", runId: 1, event: { kind: "started", total: 2 } },
        { type: "event", runId: 1, event: { kind: "file", index: 0, trackId: 1, outcome: "written" } },
        { type: "event", runId: 1, event: { kind: "file", index: 1, trackId: 2, outcome: "inUse" } },
      ],
      started,
    );
    expect(next.run).toMatchObject({ done: 2, written: 1, skipped: 2, failed: 0 });
  });

  it("counts a failed file apart from the skips", () => {
    const next = reduce([{ type: "event", runId: 1, event: { kind: "file", index: 0, trackId: 1, outcome: "failed" } }], started);
    expect(next.run).toMatchObject({ failed: 1, skipped: 1 });
  });

  it("moves to the results on the finished event", () => {
    const done = summary([{ outcome: "written", tracks: [ref(1), ref(2)] }]);
    const next = reduce([{ type: "event", runId: 1, event: { kind: "finished", summary: done } }], started);
    expect(next.phase).toBe("results");
    expect(next.summary).toBe(done);
  });

  it("marks a stop once and ignores a second request", () => {
    const stopping = reduce([{ type: "stopRequested" }, { type: "stopRequested" }], started);
    expect(stopping.run?.stopping).toBe(true);
  });

  it("falls back to the confirm with an error when the call is rejected", () => {
    const next = reduce([{ type: "callFailed", runId: 1, error: "failed" }], started);
    expect(next.phase).toBe("confirm");
    expect(next.error).toBe("failed");
    expect(canWrite(next)).toBe(false);
  });

  it("ignores events outside a run", () => {
    const idle = ready();
    expect(flowReducer(idle, { type: "event", runId: 1, event: { kind: "started", total: 4 } })).toBe(idle);
  });
});

describe("a retry", () => {
  const finished = reduce([
    { type: "previewLoaded", preview: preview() },
    { type: "runRequested", runId: 1 },
    {
      type: "event",
      runId: 1,
      event: {
        kind: "finished",
        summary: summary([
          { outcome: "written", tracks: [ref(1)] },
          { outcome: "inUse", tracks: [ref(2), ref(4)] },
          { outcome: "failed", tracks: [ref(5)] },
        ]),
      },
    },
  ]);

  it("runs only from the results and ignores an empty list", () => {
    expect(flowReducer(initialFlow, { type: "retryRequested", trackIds: [2], runId: 2 })).toBe(initialFlow);
    expect(flowReducer(finished, { type: "retryRequested", trackIds: [], runId: 2 })).toBe(finished);
  });

  it("folds its summary into the batch when it names only the retried files", () => {
    const next = reduce(
      [
        { type: "retryRequested", trackIds: [2, 4], runId: 2 },
        {
          type: "event",
          runId: 2,
          event: { kind: "finished", summary: summary([{ outcome: "written", tracks: [ref(2), ref(4)] }]) },
        },
      ],
      finished,
    );
    expect(next.phase).toBe("results");
    const view = buildResults(next.summary as StampSummary, null);
    expect(view.written.map((t) => t.trackId).sort()).toEqual([1, 2, 4]);
    expect(view.failed.map((t) => t.trackId)).toEqual([5]);
    expect(view.skipped).toEqual([]);
  });

  it("keeps a file that stays in use", () => {
    const next = reduce(
      [
        { type: "retryRequested", trackIds: [2, 4], runId: 2 },
        {
          type: "event",
          runId: 2,
          event: {
            kind: "finished",
            summary: summary([
              { outcome: "written", tracks: [ref(2)] },
              { outcome: "inUse", tracks: [ref(4)] },
            ]),
          },
        },
      ],
      finished,
    );
    const view = buildResults(next.summary as StampSummary, null);
    expect(view.written.map((t) => t.trackId).sort()).toEqual([1, 2]);
    expect(view.skipped[0].tracks.map((t) => t.trackId)).toEqual([4]);
  });

  it("falls back to the results with an error when rejected", () => {
    const next = reduce([{ type: "retryRequested", trackIds: [2], runId: 2 }, { type: "callFailed", runId: 2, error: "busy" }], finished);
    expect(next.phase).toBe("results");
    expect(next.error).toBe("busy");
    expect(next.summary).toBe(finished.summary);
  });
});

describe("undo", () => {
  const results = reduce([
    { type: "previewLoaded", preview: preview() },
    { type: "runRequested", runId: 1 },
    {
      type: "event",
      runId: 1,
      event: { kind: "finished", summary: summary([{ outcome: "written", tracks: [ref(1), ref(2)] }]) },
    },
  ]);

  it("asks, can be dismissed, then runs over the written files", () => {
    const asked = flowReducer(results, { type: "undoAsked" });
    expect(asked.undoAsk).toBe(true);
    expect(flowReducer(asked, { type: "undoDismissed" }).undoAsk).toBe(false);
    const running = flowReducer(asked, { type: "undoRequested", runId: 2 });
    expect(running.phase).toBe("undoing");
    expect(running.run).toMatchObject({ mode: "undo", total: 2 });
    expect(running.undoAsk).toBe(false);
  });

  it("ends in the undone phase and keeps the write's summary", () => {
    const undone = summary([
      { outcome: "reverted", tracks: [ref(1)] },
      { outcome: "changed", tracks: [ref(2)] },
    ]);
    const next = reduce(
      [{ type: "undoRequested", runId: 2 }, { type: "event", runId: 2, event: { kind: "finished", summary: undone } }],
      results,
    );
    expect(next.phase).toBe("undone");
    expect(next.undone).toBe(undone);
    expect(writtenOf(next.summary)).toHaveLength(2);
  });

  it("returns to the results with an error when rejected", () => {
    const next = reduce([{ type: "undoRequested", runId: 2 }, { type: "callFailed", runId: 2, error: "failed" }], results);
    expect(next.phase).toBe("results");
    expect(next.error).toBe("failed");
  });

  it("cannot be asked outside the results", () => {
    expect(flowReducer(initialFlow, { type: "undoAsked" })).toBe(initialFlow);
  });
});

describe("an undo opened from Settings", () => {
  it("opens the confirm over an empty summary and covers the stated files", () => {
    const next = flowReducer(initialFlow, { type: "undoOpened", batchId: 9, files: 5 });
    expect(next.phase).toBe("results");
    expect(next.undoAsk).toBe(true);
    const running = flowReducer(next, { type: "undoRequested", runId: 2 });
    expect(running.run).toMatchObject({ mode: "undo", total: 5 });
    expect(running.summary?.batchId).toBe(9);
  });
});


describe("an export beside the confirm", () => {
  it("disables Write while an export holds the library", () => {
    const held = flowReducer(ready(), { type: "exportChanged", held: true });
    expect(canWrite(held)).toBe(false);
    expect(flowReducer(held, { type: "runRequested", runId: 1 }).phase).toBe("confirm");
  });

  it("asks for a fresh preview when the export ends, and writes again once it loads", () => {
    const held = flowReducer(ready(), { type: "exportChanged", held: true });
    const ended = flowReducer(held, { type: "exportChanged", held: false });
    expect(ended.previewRun).toBe(held.previewRun + 1);
    expect(ended.previewState).toBe("loading");
    expect(canWrite(ended)).toBe(false);
    const fresh = flowReducer(ended, { type: "previewLoaded", preview: preview() });
    expect(canWrite(fresh)).toBe(true);
  });

  it("does not refresh a run in flight, and ignores a repeated state", () => {
    const running = reduce([{ type: "runRequested", runId: 1 }], ready());
    expect(flowReducer(running, { type: "exportChanged", held: false })).toBe(running);
    const held = flowReducer(running, { type: "exportChanged", held: true });
    expect(flowReducer(held, { type: "exportChanged", held: true })).toBe(held);
    expect(flowReducer(held, { type: "exportChanged", held: false }).previewRun).toBe(0);
  });
});

