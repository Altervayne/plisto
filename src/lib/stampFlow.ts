/*
 * The tag-write sheet's phase machine (confirm, running, results, undoing, undone) as a pure reducer. It
 * holds no React and no backend, so every transition is tested on its own; the grouping of a preview or
 * a summary lives in stampShape.
 */

// -- Utils Imports --
import { isNothingToWrite, mergeRetry, skippedCount, summaryFromEvents, writtenOf } from "./stampShape";
import type { FlowSummary, TrackLookup } from "./stampShape";

// -- Type Imports --
import type { StampEvent, StampOutcome, StampPreview } from "../types";

// -- Phase machine --

export type StampPhase = "confirm" | "running" | "results" | "undoing" | "undone";

/** Whether the preview is still loading, ready to confirm, or could not be built. */
export type PreviewState = "loading" | "ready" | "failed";

/** What a run is doing: the first write, a retry of some of its files, or an undo. */
export type RunMode = "stamp" | "retry" | "undo";

/** Why a batch call was rejected, for the line the sheet shows. */
export type FlowError = "busy" | "failed";

/** The live counters of a run. File events fold in one at a time. */
export interface RunProgress {
  mode: RunMode;
  total: number;
  done: number;
  written: number;
  skipped: number;
  failed: number;
  stopping: boolean;
  /** The tracks a retry sends, so its summary can be folded into the batch. */
  retried: number[];
  /** The track of the latest file event, for a run that has no plan to name its files. */
  lastTrackId: number | null;
}

export interface FlowState {
  phase: StampPhase;
  preview: StampPreview | null;
  previewState: PreviewState;
  run: RunProgress | null;
  /** The write's outcome, with retries folded in. Kept after an undo so the sheet can still name it. */
  summary: FlowSummary | null;
  /** The undo's outcome. */
  undone: FlowSummary | null;
  /** Whether the batch id is real. Without it Retry and Undo have nothing to address. */
  batchKnown: boolean;
  /** The token of the run in flight or last run; events and results of any other run are dropped. */
  runId: number;
  /** The undo confirm is open over the results. */
  undoAsk: boolean;
  /** Files an undo opened straight from Settings covers, before any summary of the write exists. */
  undoCount: number | null;
  /** An export holds the library now, so a write must wait. Live, unlike the preview's snapshot of it. */
  exportHeld: boolean;
  /** Counts the previews asked for, so a refresh runs the load again. */
  previewRun: number;
  /** Set while the results stand on file events alone, the call having returned without a finished event. */
  provisional: { before: FlowSummary | null } | null;
  error: FlowError | null;
}

export type FlowAction =
  | { type: "previewLoaded"; preview: StampPreview }
  | { type: "previewFailed" }
  | { type: "exportChanged"; held: boolean }
  | { type: "runRequested"; runId: number }
  | { type: "retryRequested"; trackIds: number[]; runId: number }
  | { type: "undoOpened"; batchId: number; files: number }
  | { type: "undoAsked" }
  | { type: "undoDismissed" }
  | { type: "undoRequested"; runId: number }
  | { type: "stopRequested" }
  | { type: "event"; runId: number; event: StampEvent }
  | { type: "settled"; runId: number; events: StampEvent[]; batchId: number | null; lookup?: TrackLookup }
  | { type: "callFailed"; runId: number; error: FlowError };

export const initialFlow: FlowState = {
  phase: "confirm",
  preview: null,
  previewState: "loading",
  run: null,
  summary: null,
  undone: null,
  undoAsk: false,
  undoCount: null,
  batchKnown: false,
  runId: 0,
  exportHeld: false,
  previewRun: 0,
  provisional: null,
  error: null,
};

/** A fresh counter set. A first write starts with the files the preview already left alone. */
function startRun(mode: RunMode, total: number, skipped: number, retried: number[] = []): RunProgress {
  return { mode, total, done: 0, written: 0, skipped, failed: 0, stopping: false, retried, lastTrackId: null };
}

/** Folds one file outcome into the counters. A reverted file counts as written work done. */
function countOutcome(run: RunProgress, outcome: StampOutcome): RunProgress {
  if (outcome === "written" || outcome === "reverted") return { ...run, written: run.written + 1 };
  if (outcome === "failed") return { ...run, failed: run.failed + 1 };
  return { ...run, skipped: run.skipped + 1 };
}

/** Whether the confirm may start a write: a ready preview with files and no export holding the lock. */
export function canWrite(state: FlowState): boolean {
  const preview = state.preview;
  return (
    state.phase === "confirm" &&
    state.previewState === "ready" &&
    state.error == null &&
    preview != null &&
    !preview.exportRunning &&
    !state.exportHeld &&
    !isNothingToWrite(preview)
  );
}

/** Whether Retry may be offered: the batch has a real id. */
export function canRetry(state: FlowState): boolean {
  return state.batchKnown;
}

/** Whether Undo may be offered: the batch has a real id and wrote files. */
export function canUndo(state: FlowState): boolean {
  return state.batchKnown && undoTotal(state) > 0;
}

/** How many files an undo of the current batch covers. */
export function undoTotal(state: FlowState): number {
  return writtenOf(state.summary).length || state.undoCount || 0;
}

/** The finished event that arrived after its results were built from file events: it replaces them. */
function lateFinish(state: FlowState, summary: FlowSummary): FlowState {
  const { run, provisional } = state;
  if (!run || !provisional) return state;
  if (run.mode === "undo") return { ...state, phase: "undone", undone: summary, batchKnown: true, provisional: null };
  const merged = run.mode === "retry" && provisional.before ? mergeRetry(provisional.before, summary, run.retried) : summary;
  return { ...state, phase: "results", summary: merged, batchKnown: true, provisional: null };
}

/** Whether a run is in flight, so the sheet must stay open and offer its way out. */
export function isBusy(state: FlowState): boolean {
  return state.phase === "running" || state.phase === "undoing";
}

/** The phase machine. A transition that does not fit the current phase leaves the state alone. */
export function flowReducer(state: FlowState, action: FlowAction): FlowState {
  switch (action.type) {
    case "previewLoaded":
      if (state.phase !== "confirm") return state;
      return { ...state, preview: action.preview, previewState: "ready" };

    case "previewFailed":
      if (state.phase !== "confirm") return state;
      return { ...state, previewState: "failed" };

    case "exportChanged": {
      if (action.held === state.exportHeld) return state;
      // The preview was taken while the export held the lock, so when it ends the confirm asks again.
      if (!action.held && state.phase === "confirm") {
        return { ...state, exportHeld: false, previewState: "loading", previewRun: state.previewRun + 1 };
      }
      return { ...state, exportHeld: action.held };
    }

    case "runRequested": {
      if (!canWrite(state) || !state.preview) return state;
      return {
        ...state,
        phase: "running",
        runId: action.runId,
        run: startRun("stamp", state.preview.files.length, skippedCount(state.preview)),
      };
    }

    case "retryRequested":
      if (state.phase !== "results" || action.trackIds.length === 0) return state;
      return { ...state, phase: "running", error: null, provisional: null, runId: action.runId, run: startRun("retry", action.trackIds.length, 0, action.trackIds) };

    case "undoOpened":
      if (state.phase !== "confirm") return state;
      return {
        ...state,
        phase: "results",
        summary: { batchId: action.batchId, cancelled: false, pointSaved: null, groups: [] },
        batchKnown: true,
        undoCount: action.files,
        undoAsk: true,
      };

    case "undoAsked":
      return state.phase === "results" ? { ...state, undoAsk: true } : state;

    case "undoDismissed":
      return { ...state, undoAsk: false };

    case "undoRequested": {
      if (state.phase !== "results") return state;
      return {
        ...state,
        phase: "undoing",
        undoAsk: false,
        error: null,
        provisional: null,
        runId: action.runId,
        run: startRun("undo", undoTotal(state), 0),
      };
    }

    case "stopRequested":
      if (state.phase !== "running" || !state.run || state.run.stopping) return state;
      return { ...state, run: { ...state.run, stopping: true } };

    case "event":
      return action.runId === state.runId ? applyEvent(state, action.event) : state;

    case "settled":
      return action.runId === state.runId ? settle(state, action.events, action.batchId, action.lookup) : state;

    case "callFailed": {
      if (!isBusy(state) || action.runId !== state.runId) return state;
      // A first write that never ran has nothing to show but the error; a retry or undo falls back to the results.
      if (state.run?.mode === "stamp") return { ...state, phase: "confirm", run: null, error: action.error };
      return { ...state, phase: "results", run: null, error: action.error };
    }
  }
}

/**
 * A call that returned without a finished event: the results are built from the file events seen so far,
 * and a finished event that still arrives replaces them.
 */
function settle(state: FlowState, events: StampEvent[], batchId: number | null, lookup?: TrackLookup): FlowState {
  const { run, preview, summary } = state;
  if (!isBusy(state) || !run) return state;
  const built = {
    batchId: summary?.batchId ?? batchId ?? 0,
    cancelled: run.stopping,
    events,
    lookup,
  };
  // A first write learns its batch from the lookup; a retry or an undo already had it.
  const batchKnown = summary ? state.batchKnown : batchId != null;
  if (run.mode === "undo") {
    const undone = summaryFromEvents({ ...built, preview: null, known: summary?.groups.flatMap((g) => g.tracks) ?? [] });
    return { ...state, phase: "undone", undone, batchKnown, provisional: { before: summary } };
  }
  if (run.mode === "retry" && summary) {
    const next = summaryFromEvents({ ...built, preview: null, known: summary.groups.flatMap((g) => g.tracks) });
    return { ...state, phase: "results", summary: mergeRetry(summary, next, run.retried), batchKnown, provisional: { before: summary } };
  }
  return {
    ...state,
    phase: "results",
    summary: summaryFromEvents({ ...built, preview, known: [] }),
    batchKnown,
    provisional: { before: null },
  };
}

function applyEvent(state: FlowState, event: StampEvent): FlowState {
  if (state.provisional && state.run && event.kind === "finished") return lateFinish(state, event.summary);
  if (!isBusy(state) || !state.run) return state;
  const run = state.run;
  if (event.kind === "started") return { ...state, run: { ...run, total: event.total } };
  if (event.kind === "file") {
    const counted = countOutcome(run, event.outcome);
    return { ...state, run: { ...counted, done: Math.max(run.done, event.index + 1), lastTrackId: event.trackId } };
  }
  if (state.phase === "undoing") return { ...state, phase: "undone", undone: event.summary, batchKnown: true };
  const summary =
    run.mode === "retry" && state.summary ? mergeRetry(state.summary, event.summary, run.retried) : event.summary;
  return { ...state, phase: "results", summary, batchKnown: true };
}
