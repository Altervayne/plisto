// -- Framework Imports --
import { useCallback, useEffect, useRef, useState } from "react";

// -- State Imports --
import { showFileWriteBusy, useFileWritesSheet } from "../../state/fileWrites/store";
import { usePlayerStore } from "../../state/player/store";
import { useTrimBackupDays, useTrimReplace } from "../../state/preferences/store";
import { useOfflineRoots, useRoots, useTrack } from "../../state/store";

// -- IPC Imports --
import {
  createSpliceChannel,
  keptBackupsList,
  playerStop,
  trimReplace,
  trimReplaceCancel,
  trimUndo,
} from "../../lib/ipc";

// -- Utils Imports --
import { formatBytes } from "../../lib/format";
import { blockFailure, replaceBlock, trackInUse } from "../../lib/trimReplace";
import { runWrite } from "./replaceRun";

// -- Type Imports --
import type { ReplaceBlock, ReplaceExpect, TrimFailureInfo } from "../../lib/trimReplace";
import type { Segment, SpliceProgress, TrimFailure, TrimReplaceResult } from "../../types";

// -- i18n Imports --
import { useT } from "../../i18n";

/** Where the save goes: a new file through the destination config, or over the library file. */
export type SaveMode = "new" | "replace";

/** Where an undo of the finished replace stands. */
export type UndoStep = "idle" | "confirming" | "running";

/**
 * The replace flow: the editing surface (idle, or asking to confirm), the run, its receipt with the undo
 * riding on it, the receipt of an undo, and a failed run.
 */
export type ReplaceFlow =
  | { kind: "idle" }
  | { kind: "confirming" }
  | { kind: "running" }
  | { kind: "done"; result: TrimReplaceResult; undo: UndoStep; undoFailure: TrimFailureInfo | null }
  | { kind: "undone" }
  | { kind: "failed"; failure: TrimFailureInfo };

/**
 * The trim as it stood when the confirm was asked: what the copy quotes, what the run cuts, and the row
 * values the analysis was taken from, which the run will hand the back end to compare.
 */
export interface ReplaceSnapshot {
  from: string;
  to: string;
  size: string;
  segment: Segment;
  expect: ReplaceExpect;
}

/**
 * What the workbench tells the trim about its file: the row values the analysis was taken from, whether
 * the row has moved on since or the last reread failed (`stale`, with `rereadFailed` telling which) or a
 * reread is running (`reading`), and the calls back: a finished trim or undo, a reread gesture, and
 * each write to hold.
 */
export interface TrimSource {
  expect: ReplaceExpect | null;
  stale: boolean;
  rereadFailed: boolean;
  reading: boolean;
  onRewritten: () => void;
  onReread: () => void;
  onHold: (work: Promise<unknown>) => void;
  /** Whether a write is in flight; a new one waits its turn. */
  busy: () => boolean;
}

/**
 * The replace-the-original side of the trim's Save control: whether replacing is allowed and why not,
 * the chosen mode, and the run with its undo. A blocked file reads as the new-file mode whatever was
 * chosen, and an open confirm closes to that reason. A `stale` analysis blocks like any other reason,
 * and nothing runs while `reading`. A write starts only while none is `busy`, and goes to `onHold`; a
 * finished trim or undo calls `onRewritten`, and a failure keeps the analysis and the trim so Retry cuts
 * the same snapshot.
 */
export function useTrimReplaceFlow({
  trackId,
  ext,
  expect,
  stale,
  reading,
  onRewritten,
  onReread,
  onHold,
  busy,
}: { trackId: number; ext: string } & TrimSource) {
  const enabled = useTrimReplace();
  const track = useTrack(trackId);
  const roots = useRoots();
  const offlineRootIds = useOfflineRoots();
  const inUse = usePlayerStore((s) => trackInUse(s.status, s.queue, trackId));
  const sheet = useFileWritesSheet();

  const block: ReplaceBlock | null = replaceBlock({
    enabled,
    trackId,
    ext,
    track: track ?? null,
    roots,
    offlineRootIds,
    inUse,
    stale,
  });

  const [chosen, setChosen] = useState<SaveMode>("new");
  const [flow, setFlow] = useState<ReplaceFlow>({ kind: "idle" });
  const [snapshot, setSnapshot] = useState<ReplaceSnapshot | null>(null);
  const [progress, setProgress] = useState<SpliceProgress | null>(null);
  const [goneUndoId, setGoneUndoId] = useState<number | null>(null);
  // Counts the runs that dropped back to the editing surface, so the Save control can take focus.
  const [backAt, setBackAt] = useState(0);
  const cancelAsked = useRef(false);

  // The latest block, for a write that rechecks it after its awaits; the player is read live on top,
  // since a media key can start the track between renders. An undo does not cut from the analysis, so
  // only the player and the file's reach hold it back.
  const liveRef = useRef({ block, reading });
  liveRef.current = { block, reading };
  const liveInUse = useCallback(() => {
    const { status, queue } = usePlayerStore.getState();
    return trackInUse(status, queue, trackId);
  }, [trackId]);
  const runBlocked = useCallback((): TrimFailure | null => {
    if (liveInUse()) return "inUse";
    const live = liveRef.current;
    if (live.block) return blockFailure(live.block);
    return live.reading ? "changed" : null;
  }, [liveInUse]);
  const undoBlocked = useCallback((): TrimFailure | null => {
    if (liveInUse()) return "inUse";
    const live = liveRef.current.block;
    return live?.kind === "missing" || live?.kind === "offline" ? live.kind : null;
  }, [liveInUse]);

  const mode: SaveMode = block ? "new" : chosen;

  // A confirm open when the file becomes blocked closes to the editor, which says why.
  useEffect(() => {
    if (flow.kind === "confirming" && (block || reading)) setFlow({ kind: "idle" });
  }, [flow.kind, block, reading]);

  // The receipt's backup can be discarded or undone from Kept backups; read the list on the receipt
  // and whenever a sheet closes, and drop Undo trim once the backup is gone. A failed read keeps it.
  const doneUndoId = flow.kind === "done" ? flow.result.undoId : null;
  useEffect(() => {
    if (doneUndoId == null || sheet) return;
    let live = true;
    void keptBackupsList()
      .then((list) => {
        const row = list.find((b) => b.undoId === doneUndoId);
        if (live && (!row || !row.canUndo)) setGoneUndoId(doneUndoId);
      })
      .catch(() => {});
    return () => {
      live = false;
    };
  }, [doneUndoId, sheet]);

  const sizeBytes = track?.size_bytes ?? null;
  const ask = useCallback(
    (next: { from: string; to: string; startFrame: number; endFrame: number }) => {
      if (sizeBytes == null || !expect || runBlocked()) return;
      const segment: Segment = {
        start_frame: next.startFrame,
        end_frame: next.endFrame,
        title: null,
        artist: null,
        track_no: null,
      };
      setSnapshot({ from: next.from, to: next.to, size: formatBytes(sizeBytes), segment, expect });
      setFlow({ kind: "confirming" });
    },
    [sizeBytes, expect, runBlocked],
  );

  // The dialog closes after its confirm too, so only a confirm still open goes back to editing.
  const dismissConfirm = useCallback(() => {
    setFlow((f) => (f.kind === "confirming" ? { kind: "idle" } : f));
  }, []);

  // A sounding preview holds the file open; it stops before the swap. A paused library track stays
  // seated, and the workbench restores it from the start once the file changed.
  const stopPreview = useCallback(async () => {
    const { status } = usePlayerStore.getState();
    if (status.playing && status.track_id == null) await playerStop();
  }, []);

  const run = useCallback(() => {
    if (!snapshot) return;
    const prev = flow;
    cancelAsked.current = false;
    setProgress(null);
    setFlow({ kind: "running" });
    const channel = createSpliceChannel((tick) => {
      setProgress((prev) => {
        const completed =
          prev && prev.phase === tick.phase ? Math.max(prev.completed, tick.completed) : tick.completed;
        return { ...tick, completed };
      });
    });
    const work = runWrite({
      busy,
      blocked: runBlocked,
      stopPreview,
      cancelAsked: () => cancelAsked.current,
      call: () => trimReplace({ trackId, segment: snapshot.segment, expect: snapshot.expect }, channel),
    }).then((outcome) => {
      if (outcome.kind === "done") {
        setFlow({ kind: "done", result: outcome.result, undo: "idle", undoFailure: null });
        onRewritten();
      } else if (outcome.kind === "failed") {
        setFlow({ kind: "failed", failure: outcome.failure });
      } else {
        // Refused before the swap: the file is as it was. Another write in flight says so and leaves a
        // failure showing; a block or a Cancel goes back to the editor, which says why.
        const refusedBusy = outcome.kind === "blocked" && outcome.why === "busy";
        if (refusedBusy) showFileWriteBusy();
        if (refusedBusy && prev.kind === "failed") setFlow(prev);
        else {
          setFlow({ kind: "idle" });
          setBackAt((n) => n + 1);
        }
      }
    });
    // runWrite read `busy` before its first await; a refused run is not held, so the hold keeps the
    // write in flight.
    if (!busy()) onHold(work);
  }, [flow, snapshot, busy, runBlocked, stopPreview, trackId, onRewritten, onHold]);

  const cancel = useCallback(() => {
    cancelAsked.current = true;
    void trimReplaceCancel().catch(() => {});
  }, []);

  const askUndo = useCallback(() => {
    setFlow((f) => (f.kind === "done" ? { ...f, undo: "confirming", undoFailure: null } : f));
  }, []);

  const dismissUndo = useCallback(() => {
    setFlow((f) => (f.kind === "done" && f.undo === "confirming" ? { ...f, undo: "idle" } : f));
  }, []);

  const undo = useCallback(() => {
    if (flow.kind !== "done") return;
    const { undoId } = flow.result;
    setFlow((f) => (f.kind === "done" ? { ...f, undo: "running" } : f));
    const work = runWrite({
      busy,
      blocked: undoBlocked,
      stopPreview,
      cancelAsked: () => false,
      call: () => trimUndo(undoId),
    }).then((outcome) => {
      if (outcome.kind === "done") {
        setFlow({ kind: "undone" });
        onRewritten();
        return;
      }
      // A refused undo says why on the receipt, like a failed one; another write in flight says so in
      // the busy notice instead.
      let failure: TrimFailureInfo | null = null;
      if (outcome.kind === "failed") failure = outcome.failure;
      else if (outcome.kind === "blocked" && outcome.why === "busy") showFileWriteBusy();
      else if (outcome.kind === "blocked") failure = { kind: outcome.why, code: null };
      setFlow((f) => (f.kind === "done" ? { ...f, undo: "idle", undoFailure: failure } : f));
    });
    if (!busy()) onHold(work);
  }, [flow, busy, undoBlocked, stopPreview, onRewritten, onHold]);

  /** After a `changed` failure: reread the file and go back to the trim, in the mode it was in. */
  const trimAgain = useCallback(() => {
    onReread();
    setProgress(null);
    setFlow({ kind: "idle" });
  }, [onReread]);

  /** Back to the editing surface in the new-file mode: after a receipt, or to save a failed run aside. */
  const reset = useCallback(() => {
    setChosen("new");
    setProgress(null);
    setFlow({ kind: "idle" });
  }, []);

  return {
    block,
    mode,
    choose: setChosen,
    flow,
    snapshot,
    progress,
    backAt,
    undoAvailable: flow.kind === "done" && goneUndoId !== flow.result.undoId,
    ask,
    dismissConfirm,
    run,
    cancel,
    askUndo,
    dismissUndo,
    undo,
    trimAgain,
    reset,
  };
}

export type TrimReplaceFlow = ReturnType<typeof useTrimReplaceFlow>;

/** How long the original is kept beside the trimmed file, worded to close a sentence. */
export function useKeepFor(): string {
  const t = useT();
  const days = useTrimBackupDays();
  return days === "never"
    ? t((d) => d.fileWrites.trim.keepForever)
    : t((d) => d.fileWrites.trim.keepFor, { n: Number(days) });
}
