// -- Framework Imports --
import { useCallback, useEffect, useMemo, useReducer, useRef, useState } from "react";
import type { KeyboardEvent as ReactKeyboardEvent } from "react";
import { createPortal } from "react-dom";

// -- Icon Imports --
import { History } from "lucide-react";

// -- Component Imports --
import { ConfirmDialog } from "../common/ConfirmDialog/ConfirmDialog";
import { QuietButton } from "../common/QuietButton";
import { ScrollArea } from "../common/ScrollArea/ScrollArea";
import { StampBody } from "./StampBody";
import { scopeLine } from "./stampScopeLine";
import { StampFooter } from "./StampFooter";

// -- Hook Imports --
import { useMountTransition } from "../../hooks/useMountTransition";

// -- State Imports --
import { useAppStore, useHoldSync, useReleaseSync } from "../../state/store";
import { useAlbums, useOrganizeStore, useSingles } from "../../state/organize/store";
import { useFileWritesStore } from "../../state/fileWrites/store";

// -- Utils Imports --
import { canRetry, canUndo, canWrite, flowReducer, initialFlow, isBusy, undoTotal } from "../../lib/stampFlow";
import {
  buildResults,
  buildUndone,
  describeScope,
  isNothingToWrite,
  retryIds,
  writtenOf,
} from "../../lib/stampShape";
import { busyKind } from "../../lib/busyError";
import { createStampChannel, lastFileWrite, stampCancel, stampPreview, stampRetry, stampRun, stampUndo } from "../../lib/ipc";
import { buildAlbumIndex } from "../tracks/trackAlbum";
import { escapeTarget, wrapTab } from "../gone/goneFocus";

// -- i18n Imports --
import { useT } from "../../i18n";

// -- Type Imports --
import type { StampEvent, StampScope, TrackRef } from "../../types";
import type { Channel } from "@tauri-apps/api/core";

// -- Style Imports --
import styles from "./StampSheet.module.css";

/** Names a track the batch never listed, from the library, for results built from file events alone. */
function libraryLookup(trackId: number): TrackRef | undefined {
  const row = useAppStore.getState().tracks.find((r) => r.id === trackId);
  if (!row) return undefined;
  return { trackId, title: row.title_edit ?? row.raw_title ?? row.filename, relPath: row.source_path, rootLabel: null };
}

/** The card's exit before it unmounts, matching --dur-soft on the exit keyframe. */
const EXIT_MS = 200;
/** How long after a batch call resolves its finished event may still be on the way. */
const SETTLE_MS = 2000;

/**
 * The tag-write sheet over `scope`: one card that confirms the write with its diff, runs it, lists the
 * results with Retry, and undoes it. The phase machine lives in `stampFlow`; this wires it to the
 * backend, the sync hold and the quit guard. With `undoBatchId` and no scope it opens straight on the undo
 * confirm of that batch, as Settings does from its last-write line. The card stays open while a batch runs, and every call that
 * fails leaves a line and a Close, so the sheet is never stuck.
 */
export function StampSheet({
  scope,
  undoBatchId,
  onClose,
}: {
  scope: StampScope | null;
  undoBatchId?: number;
  onClose: () => void;
}) {
  const t = useT();
  const [state, dispatch] = useReducer(flowReducer, initialFlow);
  const [open, setOpen] = useState(true);
  const card = useMountTransition(open, EXIT_MS);
  const holdSync = useHoldSync();
  const releaseSync = useReleaseSync();
  const startRun = useFileWritesStore((s) => s.startRun);
  const setRunDone = useFileWritesStore((s) => s.setRunDone);
  const endRun = useFileWritesStore((s) => s.endRun);

  const busy = isBusy(state);
  const busyRef = useRef(busy);
  busyRef.current = busy;

  const requestClose = useCallback(() => {
    if (!busyRef.current) setOpen(false);
  }, []);
  useEffect(() => {
    if (!card.mounted) onClose();
  }, [card.mounted, onClose]);

  // What an undo opened from Settings names in place of a scope.
  const [undoLabel, setUndoLabel] = useState<string | null>(null);

  // -- Scope wording --
  const albums = useAlbums();
  const singles = useSingles();
  const membership = useOrganizeStore((s) => s.org.membership);
  const totalTracks = useAppStore((s) => s.tracks.length);
  const info = useMemo(() => {
    const all = [...albums, ...singles];
    if (!scope) return { kind: "count", n: 0 } as const;
    return describeScope(scope, all, buildAlbumIndex(membership, all), totalTracks);
  }, [scope, albums, singles, membership, totalTracks]);
  const line = scope ? scopeLine(t, info) : (undoLabel ?? "");

  // -- Preview --
  useEffect(() => {
    let live = true;
    if (scope) {
      stampPreview(scope).then(
        (preview) => live && dispatch({ type: "previewLoaded", preview }),
        () => live && dispatch({ type: "previewFailed" }),
      );
    } else if (undoBatchId != null) {
      // The count the undo confirm names comes from the batch Settings reported.
      lastFileWrite().then(
        (last) =>
          live &&
          dispatch(
            last && last.batchId === undoBatchId
              ? (setUndoLabel(last.label), { type: "undoOpened", batchId: undoBatchId, files: last.files })
              : { type: "previewFailed" },
          ),
        () => live && dispatch({ type: "previewFailed" }),
      );
    }
    return () => {
      live = false;
    };
  }, [scope, undoBatchId, state.previewRun]);

  // An export holds the library while it runs; the confirm follows it live.
  const exportHeld = useAppStore((s) => s.syncHolds.includes("export"));
  useEffect(() => dispatch({ type: "exportChanged", held: exportHeld }), [exportHeld]);

  // The confirm names counts, so background sync deltas wait while it is open.
  const confirming = state.phase === "confirm";
  useEffect(() => {
    if (!confirming) return;
    holdSync("stamp");
    return () => releaseSync("stamp");
  }, [confirming, holdSync, releaseSync]);

  // The quit guard reads the running batch; it clears on every way out of a run.
  useEffect(() => {
    if (!busy) endRun();
  }, [busy, endRun]);
  useEffect(() => endRun, [endRun]);

  // -- Running a batch --
  const settle = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (settle.current) clearTimeout(settle.current);
    },
    [],
  );

  // The file events of the run in flight, kept to build results if its finished event never comes.
  const seen = useRef<StampEvent[]>([]);
  // Each run takes a token; anything a run reports after another has begun is dropped.
  const token = useRef(0);
  const run = useCallback(
    (runId: number, call: (channel: Channel<StampEvent>) => Promise<void>, firstWrite: boolean) => {
      if (settle.current) clearTimeout(settle.current);
      seen.current = [];
      const channel = createStampChannel((event) => {
        if (runId !== token.current) return;
        if (event.kind === "file") {
          seen.current.push(event);
          setRunDone(event.index + 1);
        }
        dispatch({ type: "event", runId, event });
      });
      call(channel).then(
        () => {
          // The finished event rides the channel. A call that returns without one settles on the files seen;
          // a finished event that still arrives replaces those results.
          settle.current = setTimeout(async () => {
            if (!busyRef.current || runId !== token.current) return;
            // A first write has no batch id yet; the latest write names it.
            const batchId = firstWrite ? await lastFileWrite().then((l) => l?.batchId ?? null, () => null) : null;
            if (runId !== token.current) return;
            dispatch({ type: "settled", runId, events: [...seen.current], batchId, lookup: libraryLookup });
          }, SETTLE_MS);
        },
        (error: unknown) =>
          dispatch({ type: "callFailed", runId, error: busyKind(error) === "fileWrite" ? "busy" : "failed" }),
      );
    },
    [setRunDone],
  );

  const write = () => {
    const { preview } = state;
    if (!preview || !canWrite(state)) return;
    const runId = ++token.current;
    startRun("stamp", preview.files.length);
    dispatch({ type: "runRequested", runId });
    run(runId, (channel) => stampRun(preview.previewId, channel), true);
  };

  const batchId = state.summary?.batchId ?? null;
  const retryOk = canRetry(state);
  const retry = useCallback(
    (tracks: TrackRef[]) => {
      if (batchId == null || !retryOk) return;
      const ids = retryIds(tracks);
      const runId = ++token.current;
      startRun("stamp", ids.length);
      dispatch({ type: "retryRequested", trackIds: ids, runId });
      run(runId, (channel) => stampRetry(batchId, ids, channel), false);
    },
    [batchId, retryOk, run, startRun],
  );

  // The confirm closes itself after a confirm too; this tells that apart from a cancel.
  const confirmedUndo = useRef(false);
  const undo = () => {
    if (batchId == null || !canUndo(state)) return;
    confirmedUndo.current = true;
    const runId = ++token.current;
    startRun("undo", undoTotal(state));
    dispatch({ type: "undoRequested", runId });
    run(runId, (channel) => stampUndo(batchId, channel), false);
  };

  const stop = () => {
    dispatch({ type: "stopRequested" });
    stampCancel().catch(() => {});
  };

  // -- Keyboard and focus --
  const panelRef = useRef<HTMLDivElement | null>(null);
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && escapeTarget(state.undoAsk) === "sheet") requestClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [requestClose, state.undoAsk]);

  // Focus moves into the panel on open and returns to whatever opened it when it goes.
  useEffect(() => {
    const opener = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    panelRef.current?.querySelector("button")?.focus();
    return () => opener?.focus();
  }, []);

  // Tab wraps inside the panel. The undo confirm portals out of it, so only keys from inside count.
  const onPanelKey = (event: ReactKeyboardEvent<HTMLDivElement>) => {
    const panel = panelRef.current;
    if (event.key !== "Tab" || !panel || !panel.contains(event.target as Node)) return;
    const items = [...panel.querySelectorAll<HTMLElement>("button:not([disabled]), [href], [tabindex]:not([tabindex='-1'])")];
    const next = wrapTab(items.indexOf(event.target as HTMLElement), items.length, event.shiftKey);
    if (next == null) return;
    event.preventDefault();
    items[next].focus();
  };

  // -- Derived views --
  const { preview, summary, undone, run: progress } = state;
  const results = useMemo(() => (summary ? buildResults(summary, preview) : null), [summary, preview]);
  const undoneView = useMemo(() => (undone ? buildUndone(undone) : null), [undone]);
  const current = useMemo(() => {
    if (!progress) return null;
    if (progress.mode === "stamp") return preview?.files[progress.done]?.relPath ?? null;
    if (progress.mode === "undo") {
      const listed = writtenOf(summary)[progress.done]?.relPath;
      if (listed) return listed;
      return progress.lastTrackId == null ? null : (libraryLookup(progress.lastTrackId)?.relPath ?? null);
    }
    const id = progress.retried[progress.done];
    return summary?.groups.flatMap((g) => g.tracks).find((track) => track.trackId === id)?.relPath ?? null;
  }, [progress, preview, summary]);
  const writtenCount = undoTotal(state);
  // An undo opened from Settings has no write to list behind its confirm.
  const bare = state.undoCount != null && (summary?.groups.length ?? 0) === 0;

  if (!card.mounted) return null;

  const title =
    state.phase === "running"
      ? t((d) => d.fileWrites.run.titleRunning)
      : state.phase === "undoing"
        ? t((d) => d.fileWrites.run.titleUndoing)
        : state.phase === "undone"
          ? t((d) => d.fileWrites.run.titleUndone)
          : state.phase === "results"
            ? t((d) => (summary?.cancelled ? d.fileWrites.run.titleStopped : d.fileWrites.run.titleDone))
            : t((d) => d.fileWrites.stamp.title);
  const sub = confirming ? t((d) => d.fileWrites.stamp.sub) : line;

  const errorLine =
    state.error === "busy"
      ? t((d) => d.fileWrites.busy)
      : state.error === "failed"
        ? t((d) => d.fileWrites.run.failed)
        : confirming && state.previewState === "failed"
          ? t((d) => d.fileWrites.stamp.checkFailed)
          : null;
  const confirmDead = state.error != null || state.previewState === "failed";
  const nothing = confirming && !confirmDead && preview != null && isNothingToWrite(preview);

  return createPortal(
    <div className={styles.overlay} data-state={card.state}>
      <div className={styles.backdrop} onClick={requestClose} aria-hidden="true" />

      <div
        ref={panelRef}
        className={`${styles.panel} ${info.kind === "library" ? styles.wide : ""}`}
        role="dialog"
        aria-modal="true"
        aria-label={title}
        onKeyDown={onPanelKey}
      >
        <div className={styles.header}>
          <div className={styles.heading}>
            <h2 className={styles.title}>{title}</h2>
            <p className={styles.sub}>{sub}</p>
          </div>
          <QuietButton onClick={requestClose} disabled={busy}>
            {t((d) => d.fileWrites.close)}
          </QuietButton>
        </div>

        {errorLine ? (
          <p className={styles.error} role="alert">
            {errorLine}
          </p>
        ) : null}

        <ScrollArea className={styles.list} contentClassName={styles.body}>
          <StampBody
            state={state}
            views={{ results, undone: undoneView, current, bare }}
            scope={info}
            scopeLine={line}
            confirmDead={confirmDead}
            onRetry={retryOk ? retry : undefined}
          />
        </ScrollArea>

        <div className={styles.foot}>
          <StampFooter
            state={state}
            undoCount={writtenCount}
            canUndo={canUndo(state)}
            nothing={nothing}
            confirmDead={confirmDead}
            actions={{ close: requestClose, write, stop, askUndo: () => dispatch({ type: "undoAsked" }) }}
          />
        </div>

        <ConfirmDialog
          open={state.undoAsk}
          title={t((d) => d.fileWrites.run.undoTitle)}
          prompt={t((d) => d.fileWrites.run.undoBody, { n: writtenCount })}
          confirmLabel={t((d) => d.fileWrites.run.undoConfirm)}
          cancelLabel={t((d) => d.fileWrites.cancel)}
          accent
          onConfirm={undo}
          onClose={() => {
            dispatch({ type: "undoDismissed" });
            if (bare && !confirmedUndo.current) requestClose();
          }}
        >
          <div className={styles.point}>
            <History size={15} strokeWidth={1.8} aria-hidden="true" />
            <span>{t((d) => d.fileWrites.run.undoPoint)}</span>
          </div>
        </ConfirmDialog>
      </div>
    </div>,
    document.body,
  );
}
