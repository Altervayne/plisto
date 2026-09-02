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

// -- State Imports --
import { useAppStore, useTrack } from "../../state/store";
import { usePlayerStore } from "../../state/player/store";

// -- IPC Imports --
import { createAnalyzeChannel, playerRestoreLibrary, spliceAnalyze } from "../../lib/ipc";

// -- Type Imports --
import type { AnalyzeProgress, WaveformAnalysis } from "../../types";

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

/**
 * The splice workbench: the Track Editor destination's surface, built on the album pane's
 * breadcrumb-over-body chassis. One shared shell serves both verbs, each with its own body: the
 * splitter's cut surface or the cropper's stub. On mount it analyzes the source into a waveform that
 * drives the body; the session outlives navigating off the destination, so analysis runs once per file.
 *
 * The library pause keys on `active`, the destination's visibility, not the mount: becoming active
 * captures the player's state and pauses a playing library; becoming inactive - navigated away - or
 * unmounting stops a sounding preview and restores the captured track and position. Restore is
 * frontend-owned (a preview clears the sink, so a bare resume would play silence), and a hidden session
 * in the background never holds the library paused.
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

  const [phase, setPhase] = useState<Phase>("opening");
  const [analysis, setAnalysis] = useState<WaveformAnalysis | null>(null);
  const [progress, setProgress] = useState<AnalyzeProgress | null>(null);
  const [confirmingClose, setConfirmingClose] = useState(false);

  // The body writes here whenever it holds an unsaved hand edit. Back then guards the close over it,
  // while an untouched auto-seeded state - the splitter's seeded cuts or the cropper's detected trim -
  // closes straight away.
  const dirtyRef = useRef(false);
  const requestClose = useCallback(() => {
    if (dirtyRef.current) setConfirmingClose(true);
    else onClose();
  }, [onClose]);

  // The library's state captured on entry, so leaving can restore it: whether it was playing, whether
  // a track was loaded at all, and the play head to seat it back at.
  const wasPlaying = useRef(false);
  const hadTrack = useRef(false);
  const positionSecs = useRef(0);

  // The analysis, once per mounted session. The source outlives navigating off the destination, so this
  // never re-runs while the editor is merely hidden.
  useEffect(() => {
    // Per-run cancel flag: the cleanup sets it, so a resolving analysis never touches a torn-down
    // workbench. A ref would leak across StrictMode's setup/cleanup/setup and swallow the second run.
    let cancelled = false;

    // Resolve the source once, non-reactively: a tag edit repatches the row, and depending on it
    // would re-run the analysis.
    const row = useAppStore.getState().tracks.find((r) => r.id === trackId);
    if (!row) {
      onClose();
      return;
    }

    const channel = createAnalyzeChannel((tick) => {
      if (!cancelled) setProgress(tick);
    });
    void spliceAnalyze(
      row.source_path,
      bucketCount(row.duration_secs),
      DEFAULT_THRESHOLD_DB,
      DEFAULT_MIN_SILENCE_SECS,
      channel,
    )
      .then((result) => {
        if (cancelled) return;
        setAnalysis(result);
        setPhase("editing");
      })
      .catch(() => {
        if (!cancelled) setPhase("open-error");
      });

    return () => {
      cancelled = true;
    };
  }, [trackId, onClose]);

  // The library pause, keyed on the destination's visibility. Becoming active captures the player's
  // state and pauses a playing library; becoming inactive (navigated away) or unmounting stops a
  // sounding preview and restores the captured track and position. A preview clears the sink, so
  // reopening the source is what brings the library back; a resume alone would play silence. With no
  // track loaded on entry, nothing to restore.
  useEffect(() => {
    if (!active) return;

    const player = usePlayerStore.getState();
    wasPlaying.current = player.status.playing;
    hadTrack.current = player.status.track_id != null;
    positionSecs.current = player.status.position_secs;
    if (player.status.playing) player.actions.pause();

    return () => {
      const cur = usePlayerStore.getState();
      if (cur.status.playing && cur.status.track_id == null) cur.actions.stop();
      if (hadTrack.current) void playerRestoreLibrary(positionSecs.current, wasPlaying.current);
    };
  }, [active]);

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
          ext={track.ext}
          dirtyRef={dirtyRef}
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
    </div>
  );
}
