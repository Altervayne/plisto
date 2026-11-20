// -- Framework Imports --
import { useCallback, useEffect, useRef, useState } from "react";

// -- Component Imports --
import { CenteredStage } from "../common/CenteredStage";
import { ConfirmDialog } from "../common/ConfirmDialog/ConfirmDialog";
import { QuietButton } from "../common/QuietButton";
import { ProgressLine } from "../scan/ProgressLine";
import { StaffSpinner } from "../scan/StaffSpinner";
import { WorkbenchHeader } from "./WorkbenchHeader";
import { SplitBody } from "./SplitBody";
import { TrimBody } from "./TrimBody";
import { TrimUnavailable } from "./TrimReplaceStage";

// -- State Imports --
import { useAppStore, useOfflineRoots, useRoots, useTrack } from "../../state/store";
import { usePlayerStore } from "../../state/player/store";
import { showFileWriteBusy } from "../../state/fileWrites/store";

// -- IPC Imports --
import { createAnalyzeChannel, getTracksByIds, playerRestoreLibrary, spliceAnalyze } from "../../lib/ipc";

// -- Utils Imports --
import { analysisStale, reachBlock } from "../../lib/trimReplace";
import { createLibraryHold } from "./libraryHold";

// -- Type Imports --
import type { AnalyzeProgress, WaveformAnalysis } from "../../types";
import type { ReplaceExpect } from "../../lib/trimReplace";
import type { TrimSource } from "./useTrimReplaceFlow";

// -- i18n Imports --
import { useT } from "../../i18n";

// -- Style Imports --
import styles from "./SpliceWorkbench.module.css";

/** Which screen shows: the analysis job on open, its failure, or the workbench itself. */
type Phase = "opening" | "open-error" | "editing";

/** The silence-detection defaults the analysis seeds with; the knobs to tune them arrive later. */
const DEFAULT_THRESHOLD_DB = -50;
const DEFAULT_MIN_SILENCE_SECS = 1;

/** The fixed analysis resolution, in buckets per second, clamped so short and long files both draw. */
const BUCKETS_PER_SEC = 20;
const MIN_BUCKETS = 2000;
const MAX_BUCKETS = 10000;

/** The bucket count for a file of `durationSecs`, at a fixed density clamped to a sane range. */
function bucketCount(durationSecs: number | null): number {
  const raw = Math.round((durationSecs ?? 0) * BUCKETS_PER_SEC);
  return Math.min(MAX_BUCKETS, Math.max(MIN_BUCKETS, raw));
}

/** The app's one hold on the library player across editor sessions. */
const libraryHold = createLibraryHold({
  read: () => {
    const { status } = usePlayerStore.getState();
    return { playing: status.playing, trackId: status.track_id, positionSecs: status.position_secs };
  },
  pause: () => usePlayerStore.getState().actions.pause(),
  stop: () => usePlayerStore.getState().actions.stop(),
  restore: (positionSecs, play) => {
    void playerRestoreLibrary(positionSecs, play);
  },
});

/**
 * The splice workbench: the Track Editor destination's surface, built on the album pane's
 * breadcrumb-over-body chassis. One shared shell serves both verbs, each with its own body: the
 * splitter's cut surface or the cropper's stub. On mount it analyzes the source into a waveform that
 * drives the body; the session outlives navigating off the destination, so analysis runs once per file,
 * and again after a finished trim or undo, or on Reread. The library pause keys on `active`, the
 * destination's visibility, not the mount. While a write runs, Back says so instead of closing.
 */
export function SpliceWorkbench({
  verb,
  trackId,
  active,
  onClose,
}: {
  verb: "split" | "trim";
  trackId: number;
  active: boolean;
  onClose: () => void;
}) {
  const t = useT();
  const track = useTrack(trackId);
  const roots = useRoots();
  const offlineRootIds = useOfflineRoots();

  const [phase, setPhase] = useState<Phase>("opening");
  const [analysis, setAnalysis] = useState<WaveformAnalysis | null>(null);
  const [progress, setProgress] = useState<AnalyzeProgress | null>(null);
  const [confirmingClose, setConfirmingClose] = useState(false);
  const [holdingClose, setHoldingClose] = useState(false);
  // Bumped to reread the file; `reading` covers the reread.
  const [analysisRun, setAnalysisRun] = useState(0);
  const [reading, setReading] = useState(false);
  // The row's size and mtime when the analysis was taken, to tell when the file changed since.
  const [expect, setExpect] = useState<ReplaceExpect | null>(null);
  // The store's row at that moment when it still lagged the file, and whether the last reread failed.
  const [lagging, setLagging] = useState<ReplaceExpect | null>(null);
  const [rereadFailed, setRereadFailed] = useState(false);

  // Back holds a write in flight, but the shell can still end the session (another file opened in the
  // editor). The write goes on; the app-wide busy pill says so.
  useEffect(
    () => () => {
      if (libraryHold.busy()) showFileWriteBusy();
    },
    [],
  );

  // The body writes here whenever it holds an unsaved hand edit. Back then guards the close over it,
  // while an untouched auto-seeded state - the splitter's seeded cuts or the cropper's detected trim -
  // closes straight away.
  const dirtyRef = useRef(false);
  const requestClose = useCallback(() => {
    if (libraryHold.busy()) setHoldingClose(true);
    else if (dirtyRef.current) setConfirmingClose(true);
    else onClose();
  }, [onClose]);

  // The analysis, once per mounted session and again on each reread. The source outlives navigating
  // off the destination, so this never re-runs while the editor is merely hidden. Only the first read
  // fails to the open error; a failed reread keeps the body and what it showed, and blocks the replace.
  useEffect(() => {
    // Per-run cancel flag: the cleanup sets it, so a resolving analysis never touches a torn-down
    // workbench. A ref would leak across StrictMode's setup/cleanup/setup and swallow the second run.
    let cancelled = false;
    const first = analysisRun === 0;

    // Resolve the source once, non-reactively: a tag edit repatches the row, and depending on it
    // would re-run the analysis.
    const stored = useAppStore.getState().tracks.find((r) => r.id === trackId);
    if (first && !stored) {
      onClose();
      return;
    }

    const channel = createAnalyzeChannel((tick) => {
      if (!cancelled) setProgress(tick);
    });
    // A reread asks the back end for the row: the store may not have caught up with the write yet.
    const read = async () => {
      const row = first ? stored : (await getTracksByIds([trackId]))[0];
      if (!row) throw new Error("track not in the library");
      const result = await spliceAnalyze(
        row.source_path,
        bucketCount(row.duration_secs),
        DEFAULT_THRESHOLD_DB,
        DEFAULT_MIN_SILENCE_SECS,
        channel,
      );
      return { row, result };
    };
    void read()
      .then(({ row, result }) => {
        if (cancelled) return;
        const fresh = { sizeBytes: row.size_bytes, mtime: row.mtime };
        const now = useAppStore.getState().tracks.find((r) => r.id === trackId);
        setAnalysis(result);
        setExpect(fresh);
        setLagging(now && analysisStale(fresh, now) ? { sizeBytes: now.size_bytes, mtime: now.mtime } : null);
        setRereadFailed(false);
        setPhase("editing");
      })
      .catch(() => {
        if (cancelled) return;
        if (first) setPhase("open-error");
        else setRereadFailed(true);
      })
      .finally(() => {
        if (!cancelled) setReading(false);
      });

    return () => {
      cancelled = true;
    };
  }, [trackId, onClose, analysisRun]);

  // The library pause, keyed on the destination's visibility rather than the mount. A preview clears
  // the sink, so reopening the source is what brings the library back; a resume alone would play silence.
  useEffect(() => {
    if (!active) return;
    libraryHold.enter();
    return libraryHold.leave;
  }, [active]);

  const reread = useCallback(() => {
    setReading(true);
    setAnalysisRun((n) => n + 1);
  }, []);

  // A finished trim or undo rewrote the file: reread it, and seat the library back at the start if it
  // sat on this track, since the old position no longer points at the same audio.
  const onRewritten = useCallback(() => {
    libraryHold.fileRewritten(trackId);
    reread();
  }, [trackId, reread]);

  // The row moved on since the analysis (a tag save, a rescan, an undo from Kept backups), or a reread
  // failed: saving is blocked until a reread succeeds.
  const moved = track != null && expect != null && analysisStale(expect, track, lagging);
  const stale = verb === "trim" && (rereadFailed || moved);
  const source: TrimSource = {
    expect,
    stale,
    rereadFailed,
    reading,
    onRewritten,
    onReread: reread,
    onHold: libraryHold.hold,
    busy: libraryHold.busy,
  };

  if (phase === "opening") {
    const value =
      progress && progress.total_frames > 0
        ? progress.done_frames / progress.total_frames
        : null;
    return (
      <div className={styles.view}>
        <CenteredStage>
          <div className={styles.centered}>
            <StaffSpinner />
            <h1 className={styles.title}>{t((d) => d.splice.reading)}</h1>
            <ProgressLine value={value} />
            <div className={styles.foot}>
              <QuietButton onClick={onClose}>{t((d) => d.splice.cancel)}</QuietButton>
            </div>
          </div>
        </CenteredStage>
      </div>
    );
  }

  // A trim that cannot reach its file says why, with the way back; anything else is the plain error.
  const reach = verb === "trim" && track ? reachBlock(track, roots, offlineRootIds) : null;
  if (phase === "open-error" && track && reach) {
    return (
      <div className={styles.view}>
        <WorkbenchHeader verb={verb} filename={track.filename} ext={track.ext} onBack={onClose} />
        <TrimUnavailable block={reach} onBack={onClose} />
      </div>
    );
  }

  if (phase === "open-error" || !track || !analysis) {
    return (
      <div className={styles.view}>
        <CenteredStage>
          <div className={styles.centered}>
            <p className={styles.error}>{t((d) => d.splice.openError)}</p>
            <QuietButton onClick={onClose}>{t((d) => d.splice.close)}</QuietButton>
          </div>
        </CenteredStage>
      </div>
    );
  }

  return (
    <div className={styles.view}>
      <WorkbenchHeader verb={verb} filename={track.filename} ext={track.ext} onBack={requestClose} />
      {rereadFailed && !reading ? (
        <p className={styles.rereadError} role="alert">
          {t((d) => d.fileWrites.trim.rereadFailed)}{" "}
          <button type="button" className={styles.link} onClick={reread}>
            {t((d) => d.fileWrites.trim.rereadRetry)}
          </button>
        </p>
      ) : null}
      {verb === "split" ? (
        <SplitBody
          analysis={analysis}
          path={track.source_path}
          ext={track.ext}
          dirtyRef={dirtyRef}
          onRequestClose={requestClose}
        />
      ) : (
        <TrimBody
          analysis={analysis}
          path={track.source_path}
          name={track.filename}
          ext={track.ext}
          trackId={trackId}
          dirtyRef={dirtyRef}
          source={source}
          onRequestClose={requestClose}
        />
      )}
      <ConfirmDialog
        open={confirmingClose}
        prompt={t((d) => d.splice.discardConfirm)}
        confirmLabel={t((d) => d.splice.discard)}
        cancelLabel={t((d) => d.splice.keepEditing)}
        onConfirm={onClose}
        onClose={() => setConfirmingClose(false)}
        destructive
      />
      <ConfirmDialog
        open={holdingClose}
        title={t((d) => d.fileWrites.trim.runningTitle)}
        prompt={t((d) => d.fileWrites.busy)}
        confirmLabel={t((d) => d.common.dismiss)}
        cancelLabel={t((d) => d.common.dismiss)}
        onConfirm={() => {}}
        onClose={() => setHoldingClose(false)}
        hideCancel
      />
    </div>
  );
}
