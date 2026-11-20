// -- Framework Imports --
import { useCallback, useEffect, useRef, useState } from "react";
import type { MutableRefObject } from "react";

// -- Component Imports --
import { WaveformLane } from "./WaveformLane";
import { MiniTransport } from "./MiniTransport";
import { ZoomControl } from "./ZoomControl";
import { CropControls } from "./CropControls";
import { TrimReadout } from "./TrimReadout";
import { SpliceOutputConfig } from "./SpliceOutputConfig";
import { TrimSaveControl } from "./TrimSaveControl";
import { TrimNewDone, TrimNewRunning } from "./TrimNewFileStage";
import { TrimReplaceStage } from "./TrimReplaceStage";
import { TrimReplaceConfirm } from "./TrimReplaceDialogs";

// -- Hook Imports --
import { usePreviewScrub } from "./usePreviewScrub";
import { usePreviewToggle } from "./usePreviewToggle";
import { useWorkbenchKeys } from "./useWorkbenchKeys";
import { useTrimSaveAsNew } from "./useTrimSaveAsNew";
import { useKeepFor, useTrimReplaceFlow } from "./useTrimReplaceFlow";
import type { TrimSource } from "./useTrimReplaceFlow";

// -- State Imports --
import {
  PREF_KEYS,
  usePreference,
  useRetireTrimHint,
  useSetPreference,
  useTrimHintDue,
} from "../../state/preferences/store";

// -- IPC Imports --
import { playerPreview, spliceDetectSilence } from "../../lib/ipc";

// -- Utils Imports --
import { snapFrame, spliceFormat } from "../../lib/splice";
import { applyPadding, detectTrim, paddingFrames, trimsAnything } from "../../lib/crop";
import { formatDuration } from "../../lib/format";

// -- Type Imports --
import type { WaveformAnalysis } from "../../types";
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

/** A pref string as a finite number, or the fallback when it is absent or unparsable. */
function numberPref(value: string | undefined, fallback: number): number {
  if (value == null) return fallback;
  const n = Number(value);
  return Number.isFinite(n) ? n : fallback;
}

/**
 * The cropper's surface. Editing is the waveform lane with its two trim handles over the transport and
 * zoom, beside the panel holding the threshold and padding knobs, the head/tail readout, and the Save
 * control: a new file, or the library file replaced in place. Each save has its own centered screens.
 * The body owns the trim: two points derived from the file's silence, widened by the padding, cut as one
 * segment. A new `analysis` - the file reread after a finished write, or on Reread - seeds a fresh trim.
 * The workbench owns the file and its rereads through `source`.
 */
export function TrimBody({
  analysis,
  path,
  name,
  ext,
  trackId,
  dirtyRef,
  source,
  onRequestClose,
}: {
  analysis: WaveformAnalysis;
  path: string;
  name: string;
  ext: string;
  trackId: number;
  dirtyRef?: MutableRefObject<boolean>;
  source: TrimSource;
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

  // The detected-or-hand trim points, seeded from the analysis silence (the common case, free on open).
  // Padding widens these into the effective cut; a hand drag moves them and holds detection off.
  const [base, setBase] = useState(() => detectTrim(analysis.silence, totalFrames, epsilon));
  const [handMoved, setHandMoved] = useState(false);
  const [touched, setTouched] = useState(false);

  // A reread file is a new source: seed its trim afresh and park the playhead at the start.
  const [seededFrom, setSeededFrom] = useState(analysis);
  if (seededFrom !== analysis) {
    setSeededFrom(analysis);
    setBase(detectTrim(analysis.silence, totalFrames, epsilon));
    setHandMoved(false);
    setTouched(false);
    setPlayheadSecs(0);
  }

  const storedThreshold = usePreference(PREF_KEYS.spliceThresholdDb);
  const storedPadding = usePreference(PREF_KEYS.splicePaddingMs);
  const setPreference = useSetPreference();
  const trimHintDue = useTrimHintDue();
  const retireTrimHint = useRetireTrimHint();
  const thresholdDb = numberPref(storedThreshold, DEFAULT_THRESHOLD_DB);
  const paddingMs = numberPref(storedPadding, DEFAULT_PADDING_MS);

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

  // Reconcile a remembered threshold with each analysis' trim: the analysis ran at the default, so only
  // a differing remembered threshold needs a detect. A detect still running against the previous file is
  // voided first. Idempotent through the generation guard; the knob handler owns every later re-detect.
  useEffect(() => {
    detectGen.current += 1;
    if (thresholdDb !== ANALYSIS_THRESHOLD_DB) void redetect(thresholdDb);
  }, [analysis]);

  // The first handle drag retires the hint for good.
  useEffect(() => {
    if (handMoved) retireTrimHint();
  }, [handMoved]);

  // The snapped trim points the handles, veil, and readout show: the frame grid the format can land on,
  // made visible so the shown times match what the cut writes.
  const inFrame = snapFrame(base.inFrame, format, sampleRate);
  const outFrame = snapFrame(base.outFrame, format, sampleRate);

  // The effective kept range the cut writes: the snapped points widened by the padding, clamped to the
  // file. Feeds the job, the play-kept preview, and the run gate; the waveform shows the un-padded points.
  const pad = paddingFrames(paddingMs, sampleRate);
  const effective = applyPadding({ inFrame, outFrame }, pad, totalFrames);
  const canTrim = trimsAnything(effective, totalFrames);
  const resultSecs = Math.max(0, effective.out - effective.in) / sampleRate;

  // A run acts on the trim, so the unsaved-edits flag clears; a later edit re-arms it.
  const clearTouched = useCallback(() => setTouched(false), []);
  // Neither save cuts from a stale or rereading analysis: its frames may not match the file now.
  const canCut = canTrim && !source.stale && !source.reading;
  const cutHint = !canTrim
    ? t((d) => d.splice.trimNothing)
    : t((d) => (source.reading ? d.fileWrites.trim.why.rereading : d.fileWrites.trim.rereadFirst));
  const newFile = useTrimSaveAsNew({ path, range: effective, canTrim: canCut, onStart: clearTouched });

  const replace = useTrimReplaceFlow({ trackId, ext, ...source });
  const keep = useKeepFor();
  const { flow } = replace;

  // The trim surface shows while neither save is past its confirm.
  const editing = newFile.phase === "editing" && (flow.kind === "idle" || flow.kind === "confirming");

  // Publish the close-guard signal: an unsaved edit on the trim surface arms it, and so does one kept
  // behind a failed replace, which Back would otherwise drop.
  const guarded = editing || flow.kind === "failed";
  useEffect(() => {
    if (dirtyRef) dirtyRef.current = guarded && touched;
  }, [dirtyRef, guarded, touched]);

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

  const onReplace = () => {
    if (!canTrim) return;
    replace.ask({
      from: formatDuration(durationSecs),
      to: formatDuration(resultSecs),
      startFrame: effective.in,
      endFrame: effective.out,
    });
  };

  // The cropper's reduced shortcut map: no tool or marker keys, just Space to toggle the preview and
  // Escape to step from a sounding preview back to the workbench close.
  useWorkbenchKeys(editing && flow.kind === "idle", {
    onZoomIn: () => laneZoomRef.current?.zoomIn(),
    onZoomOut: () => laneZoomRef.current?.zoomOut(),
    onFit: () => laneZoomRef.current?.fit(),
    onTogglePreview: preview.toggle,
    isSounding: () => preview.sounding,
    onStopPreview: preview.stop,
    onClose: onRequestClose,
  });

  if (newFile.phase === "running") {
    return <TrimNewRunning destination={newFile.destination} progress={newFile.progress} />;
  }

  if (newFile.phase === "done" && newFile.report) {
    return (
      <TrimNewDone
        report={newFile.report}
        destination={newFile.destination}
        addState={newFile.addState}
        onAddToLibrary={newFile.onAddToLibrary}
        onTrimAgain={newFile.onTrimAgain}
      />
    );
  }

  if (flow.kind !== "idle" && flow.kind !== "confirming" && replace.snapshot) {
    return <TrimReplaceStage replace={replace} path={path} name={name} reloading={source.reading} />;
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

        {trimHintDue ? <p className={styles.trimHint}>{t((d) => d.splice.trimHint)}</p> : null}

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
            resultSecs={resultSecs}
            sampleRate={sampleRate}
            onHead={onMoveIn}
            onTail={onMoveOut}
            onPlayKept={onPlayKept}
          />
          <div className={styles.configFoot}>
            <TrimSaveControl
              replace={replace}
              path={path}
              canTrim={canTrim}
              source={source}
              onReplace={onReplace}
            >
              <SpliceOutputConfig
                destination={newFile.destination}
                check={newFile.check}
                checking={newFile.checking}
                collision={newFile.collision}
                segmentCount={1}
                confirming={newFile.confirmingRun}
                runError={newFile.runError}
                canRun={canCut}
                runLabel={t((d) => d.splice.trimCta)}
                disabledHint={cutHint}
                onPickDestination={newFile.onPickDestination}
                onCollision={newFile.setCollision}
                onRun={newFile.onRun}
                onConfirmRun={() => void newFile.runTrim()}
                onCancelConfirm={() => newFile.setConfirmingRun(false)}
              />
            </TrimSaveControl>
          </div>
        </div>
      </div>

      <TrimReplaceConfirm
        open={flow.kind === "confirming"}
        name={name}
        snapshot={replace.snapshot}
        keep={keep}
        onConfirm={replace.run}
        onClose={replace.dismissConfirm}
      />
    </div>
  );
}
