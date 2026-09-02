// -- Framework Imports --
import { useCallback, useEffect, useRef, useState } from "react";
import type { MutableRefObject } from "react";

// -- Component Imports --
import { CenteredStage } from "../common/CenteredStage";
import { QuietButton } from "../common/QuietButton";
import { Tooltip } from "../common/Tooltip/Tooltip";
import { ProgressLine } from "../scan/ProgressLine";
import { StaffSpinner } from "../scan/StaffSpinner";
import { WaveformLane } from "./WaveformLane";
import { MiniTransport } from "./MiniTransport";
import { ZoomControl } from "./ZoomControl";
import { CropControls } from "./CropControls";
import { TrimReadout } from "./TrimReadout";
import { SpliceOutputConfig } from "./SpliceOutputConfig";
import { SpliceRunReport } from "./SpliceRunReport";

// -- Hook Imports --
import { useSpliceDestination } from "./useSpliceDestination";
import { usePreviewScrub } from "./usePreviewScrub";
import { usePreviewToggle } from "./usePreviewToggle";
import { useWorkbenchKeys } from "./useWorkbenchKeys";

// -- State Imports --
import { PREF_KEYS, usePreference, useSetPreference } from "../../state/preferences/store";
import { useAddRootPath } from "../../state/store";

// -- IPC Imports --
import {
  createSpliceChannel,
  playerPreview,
  spliceCancel,
  spliceDetectSilence,
  spliceRun,
} from "../../lib/ipc";

// -- Utils Imports --
import { snapFrame, spliceFormat } from "../../lib/splice";
import { applyPadding, detectTrim, paddingFrames, sourceStem, trimsAnything } from "../../lib/crop";
import { openFolder } from "../../lib/opener";

// -- Type Imports --
import type {
  CollisionPolicy,
  SpliceJob,
  SpliceProgress,
  SpliceReport,
  WaveformAnalysis,
} from "../../types";
import type { WaveformLaneHandle, ZoomState } from "./WaveformLane";

// -- i18n Imports --
import { useT } from "../../i18n";

// -- Style Imports --
import styles from "./TrimBody.module.css";

/** The zoom snapshot before the lane has measured: fit, with nowhere to step. */
const INITIAL_ZOOM: ZoomState = { secondsVisible: 0, atFit: true, canIn: false, canOut: false };

/** The threshold the workbench analysis ran at, so the opening trim comes free from its silence spans. */
const ANALYSIS_THRESHOLD_DB = -50;
/** The silence floor and minimum span a re-detection uses; the threshold is the cropper's own knob. */
const DEFAULT_THRESHOLD_DB = -50;
const DEFAULT_MIN_SILENCE_SECS = 1;
/** A touch of lead-in and tail so a trim never clips the attack or the release. */
const DEFAULT_PADDING_MS = 75;
/** How close to an edge a silence span counts as touching it, when deriving the trim. */
const EDGE_EPSILON_SECS = 0.05;

/** Which screen the body shows: the trim surface, the live run, or the done report. */
type SubPhase = "editing" | "running" | "done";

/** Where the add-to-library action sits: unstarted, indexing, or done. */
type AddState = "idle" | "adding" | "added";

/** A pref string as a finite number, or the fallback when it is absent or unparsable. */
function numberPref(value: string | undefined, fallback: number): number {
  if (value == null) return fallback;
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * The cropper's surface across its three phases. Editing is the waveform lane with its two trim
 * handles over the transport and zoom, beside the panel that holds the threshold and padding knobs, the
 * head/tail readout, the destination, and the one solid Trim CTA. Running is a centered determinate
 * stage; done is a centered report with follow-on actions. The body owns the trim: two points derived
 * from the file's silence, widened by the padding, cut as a single segment that keeps the source name.
 * A hand-moved handle or a changed knob not yet run arms the workbench's close-guard.
 */
export function TrimBody({
  analysis,
  path,
  ext,
  dirtyRef,
  onRequestClose,
}: {
  analysis: WaveformAnalysis;
  path: string;
  ext: string;
  dirtyRef?: MutableRefObject<boolean>;
  onRequestClose: () => void;
}) {
  const t = useT();

  const { sample_rate: sampleRate, total_frames: totalFrames, duration_secs: durationSecs } = analysis;
  const format = spliceFormat(ext);
  const epsilon = Math.round(sampleRate * EDGE_EPSILON_SECS);

  const [playheadSecs, setPlayheadSecs] = useState(0);
  const laneZoomRef = useRef<WaveformLaneHandle>(null);
  const [zoomState, setZoomState] = useState<ZoomState>(INITIAL_ZOOM);

  const { isScrubbing, notePlayhead, onScrubStart, onScrubEnd } = usePreviewScrub(path, durationSecs);
  const preview = usePreviewToggle(path, playheadSecs, durationSecs);

  // The playhead setter the lane and transport share: it feeds the scrub bridge so a release
  // re-auditions a live preview from the dropped point.
  const setPlayhead = useCallback(
    (secs: number) => {
      setPlayheadSecs(secs);
      notePlayhead(secs);
    },
    [notePlayhead],
  );

  // The detected-or-hand trim points, seeded once from the analysis silence (the common case, free on
  // open). Padding widens these into the effective cut; a hand drag moves them and holds detection off.
  const [base, setBase] = useState(() => detectTrim(analysis.silence, totalFrames, epsilon));
  const [handMoved, setHandMoved] = useState(false);
  const [touched, setTouched] = useState(false);

  const [subPhase, setSubPhase] = useState<SubPhase>("editing");
  const [collision, setCollision] = useState<CollisionPolicy>("rename");
  const [confirmingRun, setConfirmingRun] = useState(false);
  const [runError, setRunError] = useState<string | null>(null);
  const [progress, setProgress] = useState<SpliceProgress | null>(null);
  const [report, setReport] = useState<SpliceReport | null>(null);
  const [addState, setAddState] = useState<AddState>("idle");

  const storedThreshold = usePreference(PREF_KEYS.spliceThresholdDb);
  const storedPadding = usePreference(PREF_KEYS.splicePaddingMs);
  const setPreference = useSetPreference();
  const thresholdDb = numberPref(storedThreshold, DEFAULT_THRESHOLD_DB);
  const paddingMs = numberPref(storedPadding, DEFAULT_PADDING_MS);

  const { destination, check, pick } = useSpliceDestination();
  const addRootPath = useAddRootPath();

  // A detection generation, so a stale re-detect (an earlier threshold) never lands over a newer one.
  // A monotonic counter, not a boolean gate, so StrictMode's double mount never swallows a run.
  const detectGen = useRef(0);
  const redetect = useCallback(
    async (db: number) => {
      const gen = ++detectGen.current;
      try {
        const spans = await spliceDetectSilence(path, db, DEFAULT_MIN_SILENCE_SECS);
        if (gen === detectGen.current) setBase(detectTrim(spans, totalFrames, epsilon));
      } catch {
        // A detect failure leaves the current trim in place; the source already analyzed on open.
      }
    },
    [path, totalFrames, epsilon],
  );

  // Reconcile a remembered threshold with the opening trim: the analysis ran at the default, so only a
  // differing remembered threshold needs a detect on open. Runs once; later changes go through the knob.
  useEffect(() => {
    // The threshold reflects the analysis on open, so only a differing remembered one needs a detect.
    // Mount-only, and idempotent through redetect's generation guard - no ref gate to leak under
    // StrictMode's double mount, and the knob handler owns every later re-detect.
    if (thresholdDb !== ANALYSIS_THRESHOLD_DB) void redetect(thresholdDb);
  }, []);

  // Publish the close-guard signal: only an unsaved edit on the trim surface arms it.
  useEffect(() => {
    if (dirtyRef) dirtyRef.current = subPhase === "editing" && touched;
  }, [dirtyRef, subPhase, touched]);

  // The snapped trim points the handles, veil, and readout show: the frame grid the format can land on,
  // made visible so the shown times match what the cut writes.
  const inFrame = snapFrame(base.inFrame, format, sampleRate);
  const outFrame = snapFrame(base.outFrame, format, sampleRate);

  // The effective kept range the cut writes: the snapped points widened by the padding, clamped to the
  // file. Feeds the job, the play-kept preview, and the run gate; the waveform shows the un-padded points.
  const pad = paddingFrames(paddingMs, sampleRate);
  const effective = applyPadding({ inFrame, outFrame }, pad, totalFrames);
  const canTrim = trimsAnything(effective, totalFrames);

  const onMoveIn = useCallback(
    (frame: number) => {
      const snapped = snapFrame(frame, format, sampleRate);
      setBase((b) => ({ ...b, inFrame: Math.min(Math.max(0, snapped), b.outFrame - 1) }));
      setHandMoved(true);
      setTouched(true);
    },
    [format, sampleRate],
  );

  const onMoveOut = useCallback(
    (frame: number) => {
      const snapped = snapFrame(frame, format, sampleRate);
      setBase((b) => ({ ...b, outFrame: Math.max(Math.min(totalFrames, snapped), b.inFrame + 1) }));
      setHandMoved(true);
      setTouched(true);
    },
    [format, sampleRate, totalFrames],
  );

  const onThreshold = (db: number) => {
    setPreference(PREF_KEYS.spliceThresholdDb, String(db));
    setTouched(true);
    // A hand-moved trim is respected: the threshold no longer re-detects until Re-detect opts back in.
    if (!handMoved) void redetect(db);
  };

  const onPadding = (ms: number) => {
    setPreference(PREF_KEYS.splicePaddingMs, String(ms));
    setTouched(true);
  };

  const onRedetect = () => {
    setHandMoved(false);
    setTouched(true);
    void redetect(thresholdDb);
  };

  const onPlayKept = () => {
    void playerPreview(path, effective.in / sampleRate, effective.out / sampleRate).catch(() => {});
  };

  const onPickDestination = () => {
    setConfirmingRun(false);
    setRunError(null);
    void pick();
  };

  const runTrim = useCallback(async () => {
    if (!destination || !canTrim) return;
    setConfirmingRun(false);
    setRunError(null);
    setProgress(null);
    setReport(null);
    setAddState("idle");
    // A run acts on the trim, so the unsaved-edits flag clears; a later edit re-arms it.
    setTouched(false);
    setSubPhase("running");

    const channel = createSpliceChannel((tick) => {
      setProgress((prev) => {
        const completed =
          prev && prev.phase === tick.phase ? Math.max(prev.completed, tick.completed) : tick.completed;
        return { ...tick, completed };
      });
    });

    // One segment, no tags of its own: the naming pattern is the source stem (no tokens), so the trimmed
    // file keeps the source's own name. The cropper keeps the source tag verbatim - same track, every
    // field and the cover carried across.
    const job: SpliceJob = {
      source_path: path,
      segments: [
        { start_frame: effective.in, end_frame: effective.out, title: null, artist: null, track_no: null },
      ],
      destination,
      naming_pattern: sourceStem(path),
      collision,
      keep_source_tags: true,
    };

    try {
      setReport(await spliceRun(job, channel));
      setSubPhase("done");
    } catch {
      // The source is read-only, so a failed run leaves it untouched; drop back with the reason.
      setRunError(t((d) => d.splice.trimFailed));
      setSubPhase("editing");
    }
  }, [destination, canTrim, path, effective.in, effective.out, collision, t]);

  const onRunClick = useCallback(() => {
    if (check?.non_empty) setConfirmingRun(true);
    else void runTrim();
  }, [check, runTrim]);

  const onAddToLibrary = useCallback(() => {
    if (!destination) return;
    setAddState("adding");
    void addRootPath(destination)
      .then((ok) => setAddState(ok ? "added" : "idle"))
      .catch(() => setAddState("idle"));
  }, [destination, addRootPath]);

  const onTrimAgain = useCallback(() => {
    setReport(null);
    setProgress(null);
    setRunError(null);
    setConfirmingRun(false);
    setAddState("idle");
    setSubPhase("editing");
  }, []);

  // The cropper's reduced shortcut map: no tool or marker keys, just Space to toggle the preview and
  // Escape to step from a sounding preview back to the workbench close.
  useWorkbenchKeys(subPhase === "editing", {
    onZoomIn: () => laneZoomRef.current?.zoomIn(),
    onZoomOut: () => laneZoomRef.current?.zoomOut(),
    onFit: () => laneZoomRef.current?.fit(),
    onTogglePreview: preview.toggle,
    isSounding: () => preview.sounding,
    onStopPreview: preview.stop,
    onClose: onRequestClose,
  });

  if (subPhase === "running") {
    const total = progress?.total ?? 1;
    const completed = progress?.completed ?? 0;
    const errors = progress?.errors ?? 0;
    const value = total > 0 ? completed / total : null;
    return (
      <CenteredStage>
        <div className={styles.centered}>
          <StaffSpinner />
          <h1 className={styles.title}>{t((d) => d.splice.trimming)}</h1>
          {destination ? (
            <Tooltip label={destination}>
              <p className={styles.path}>{destination}</p>
            </Tooltip>
          ) : null}
          <ProgressLine value={value} />
          <div className={`${styles.counters} tabular`}>
            <span>
              {completed} / {total}
            </span>
            {errors > 0 ? (
              <span className={styles.tally}>{t((d) => d.export.errors, { n: errors })}</span>
            ) : null}
          </div>
          <div className={styles.foot}>
            <QuietButton onClick={() => void spliceCancel()}>
              {t((d) => d.splice.cancel)}
            </QuietButton>
          </div>
        </div>
      </CenteredStage>
    );
  }

  if (subPhase === "done" && report) {
    const title = report.cancelled
      ? t((d) => d.splice.stopped, { done: report.written, total: report.total })
      : t((d) => d.splice.wrote, { n: report.written });
    const addLabel =
      addState === "adding"
        ? t((d) => d.splice.addingToLibrary)
        : addState === "added"
          ? t((d) => d.splice.addedToLibrary)
          : t((d) => d.splice.addToLibrary);
    return (
      <CenteredStage>
        <div className={styles.centered}>
          <span className={styles.dot} aria-hidden="true" />
          <h1 className={styles.title}>{title}</h1>
          <SpliceRunReport report={report} />
          <div className={styles.actions}>
            <QuietButton
              onClick={onAddToLibrary}
              disabled={report.written === 0 || addState !== "idle"}
            >
              {addLabel}
            </QuietButton>
            {destination ? (
              <QuietButton onClick={() => void openFolder(destination)}>
                {t((d) => d.export.openFolder)}
              </QuietButton>
            ) : null}
            <QuietButton onClick={onTrimAgain}>{t((d) => d.splice.trimAgain)}</QuietButton>
          </div>
        </div>
      </CenteredStage>
    );
  }

  return (
    <div className={styles.body}>
      <div className={styles.main}>
        <div className={styles.laneWrap}>
          <WaveformLane
            ref={laneZoomRef}
            peaks={analysis.peaks}
            silence={[]}
            totalFrames={totalFrames}
            durationSecs={durationSecs}
            playheadSecs={playheadSecs}
            onScrub={setPlayhead}
            onScrubStart={onScrubStart}
            onScrubEnd={onScrubEnd}
            onZoomState={setZoomState}
            crop={{ inFrame, outFrame, onMoveIn, onMoveOut }}
          />
        </div>

        <div className={styles.controls}>
          <MiniTransport
            path={path}
            playheadSecs={playheadSecs}
            durationSecs={durationSecs}
            onPlayhead={setPlayhead}
            suspendSync={isScrubbing}
          />
          <div className={styles.viewControls}>
            <ZoomControl
              state={zoomState}
              onZoomIn={() => laneZoomRef.current?.zoomIn()}
              onZoomOut={() => laneZoomRef.current?.zoomOut()}
              onFit={() => laneZoomRef.current?.fit()}
            />
          </div>
        </div>
      </div>

      <div className={styles.panel}>
        <div className={styles.panelInner}>
          <CropControls
            thresholdDb={thresholdDb}
            paddingMs={paddingMs}
            handMoved={handMoved}
            onThreshold={onThreshold}
            onPadding={onPadding}
            onRedetect={onRedetect}
          />
          <TrimReadout
            inFrame={inFrame}
            outFrame={outFrame}
            resultSecs={Math.max(0, effective.out - effective.in) / sampleRate}
            sampleRate={sampleRate}
            onHead={onMoveIn}
            onTail={onMoveOut}
            onPlayKept={onPlayKept}
          />
          <div className={styles.configFoot}>
            <SpliceOutputConfig
              destination={destination}
              check={check}
              collision={collision}
              segmentCount={1}
              confirming={confirmingRun}
              runError={runError}
              canRun={canTrim}
              runLabel={t((d) => d.splice.trimCta)}
              disabledHint={t((d) => d.splice.trimNothing)}
              onPickDestination={onPickDestination}
              onCollision={setCollision}
              onRun={onRunClick}
              onConfirmRun={() => void runTrim()}
              onCancelConfirm={() => setConfirmingRun(false)}
            />
          </div>
        </div>
      </div>
    </div>
  );
}
