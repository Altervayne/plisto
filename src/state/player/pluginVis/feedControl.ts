/*
 * The readout's Record feed control: one press records, a second press ends it early, and the outcome shows
 * as a line until it fades. The recorder outlives any chip, so the control holds no recording state of its
 * own: it follows the recorder's published state, which a chip mounted mid-recording or after the save reads
 * the same way. Only a refusal for a recording already running is kept here, as the recorder has no state
 * of its own to show for it.
 */

// -- Framework Imports --
import { useEffect, useRef, useState } from "react";

// -- State Imports --
import { FeedRecordError, RECORD_MS, startFeedRecording, stopFeedRecording } from "./recordFeed";
import type { RecordRefusal } from "./recordFeed";
import { feedRecording, RESULT_MS, subscribeFeedRecording } from "./feedRecording";
import type { FeedRecording } from "./feedRecording";

export type FeedOutcome =
  { ok: true; file: string } | { ok: false; reason: RecordRefusal; detail: string | null };

export interface FeedState {
  phase: "idle" | "recording" | "saving";
  // Whole seconds recorded so far, up to the recording length.
  secs: number;
  outcome: FeedOutcome | null;
}

export const IDLE_FEED: FeedState = { phase: "idle", secs: 0, outcome: null };

export interface FeedDeps {
  start: (kind: string) => Promise<{ path: string }>;
  stop: () => void;
  now: () => number;
  read: () => FeedRecording;
  subscribe: (notify: () => void) => () => void;
}

const productionDeps: FeedDeps = {
  start: startFeedRecording,
  stop: stopFeedRecording,
  now: () => Date.now(),
  read: feedRecording,
  subscribe: subscribeFeedRecording,
};

/** The last segment of a saved file's path, either separator. */
export const baseName = (path: string): string => path.split(/[\\/]/).pop() || path;

export interface FeedControl {
  // Starts a recording, or ends the running one early; nothing while it saves.
  press: () => void;
  dispose: () => void;
}

export function createFeedControl(
  kind: string,
  onState: (state: FeedState) => void,
  deps: FeedDeps = productionDeps,
): FeedControl {
  let state = IDLE_FEED;
  let disposed = false;
  let busy: FeedOutcome | null = null;
  let ticker: ReturnType<typeof setInterval> | undefined;
  let fade: ReturnType<typeof setTimeout> | undefined;

  const view = (): FeedState => {
    const r = deps.read();
    const mine = r.kind === kind;
    const phase = mine ? r.phase : "idle";
    const secs =
      phase === "recording" ? Math.min(RECORD_MS / 1000, Math.floor((deps.now() - r.startedAt) / 1000)) : 0;
    const shown: FeedOutcome | null =
      mine && r.outcome ? (r.outcome.ok ? { ok: true, file: baseName(r.outcome.path) } : r.outcome) : busy;
    return { phase, secs, outcome: phase === "idle" ? shown : null };
  };

  const emit = () => {
    if (disposed) return;
    const next = view();
    const same =
      next.phase === state.phase &&
      next.secs === state.secs &&
      JSON.stringify(next.outcome) === JSON.stringify(state.outcome);
    if (!same) {
      state = next;
      onState(state);
    }
    if (state.phase === "recording" && ticker === undefined) ticker = setInterval(emit, 250);
    if (state.phase !== "recording" && ticker !== undefined) {
      clearInterval(ticker);
      ticker = undefined;
    }
  };

  const unsubscribe = deps.subscribe(emit);
  emit();

  const press = () => {
    if (state.phase === "saving") return;
    if (state.phase === "recording") {
      deps.stop();
      return;
    }
    busy = null;
    clearTimeout(fade);
    deps.start(kind).catch((e) => {
      const err = e instanceof FeedRecordError ? e : new FeedRecordError("save_failed", String(e));
      if (err.reason !== "busy") return;
      busy = { ok: false, reason: err.reason, detail: err.detail };
      fade = setTimeout(() => {
        busy = null;
        emit();
      }, RESULT_MS);
      emit();
    });
  };

  const dispose = () => {
    disposed = true;
    unsubscribe();
    clearInterval(ticker);
    clearTimeout(fade);
  };
  return { press, dispose };
}

/** The Record feed control for a kind, with its state; the recording itself outlives the component. */
export function useFeedControl(kind: string): [FeedState, () => void] {
  const [state, setState] = useState<FeedState>(IDLE_FEED);
  const control = useRef<FeedControl | null>(null);
  useEffect(() => {
    const next = createFeedControl(kind, setState);
    control.current = next;
    return () => {
      next.dispose();
      control.current = null;
    };
  }, [kind]);
  return [state, () => control.current?.press()];
}
