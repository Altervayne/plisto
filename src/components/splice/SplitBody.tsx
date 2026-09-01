// -- Framework Imports --
import { useCallback, useEffect, useRef, useState } from "react";
import type { CSSProperties, MutableRefObject } from "react";

// -- Icon Imports --
import { FileMusic, MapPin, ScanLine } from "lucide-react";

// -- Component Imports --
import { CenteredStage } from "../common/CenteredStage";
import { QuietButton } from "../common/QuietButton";
import { Resizer } from "../common/Resizer/Resizer";
import { Tooltip } from "../common/Tooltip/Tooltip";
import { ProgressLine } from "../scan/ProgressLine";
import { StaffSpinner } from "../scan/StaffSpinner";
import { WaveformLane } from "./WaveformLane";
import { MiniTransport } from "./MiniTransport";
import { ZoomControl } from "./ZoomControl";
import { CutList } from "./CutList";
import { SpliceOutputConfig } from "./SpliceOutputConfig";
import { SpliceRunReport } from "./SpliceRunReport";

// -- Hook Imports --
import { useDrawerResize } from "../common/Resizer/useDrawerResize";
import { useCutModel } from "./useCutModel";

// -- State Imports --
import { PREF_KEYS, usePreference, useSetPreference } from "../../state/preferences/store";
import { useAddRootPath } from "../../state/store";

// -- IPC Imports --
import {
  createSpliceChannel,
  playerPreview,
  spliceCancel,
  spliceDetectSilence,
  spliceParseCue,
  spliceRun,
  validateExportDestination,
} from "../../lib/ipc";
import { pickCueFile, pickFolder } from "../../lib/dialog";

// -- Utils Imports --
import { snapFrame, spliceFormat } from "../../lib/splice";
import { openFolder } from "../../lib/opener";
import { toJobSegments } from "./cutModel";

// -- Type Imports --
import type {
  CollisionPolicy,
  DestinationCheck,
  SpliceJob,
  SpliceProgress,
  SpliceReport,
  WaveformAnalysis,
} from "../../types";
import type { Zoom } from "./WaveformLane";

// -- i18n Imports --
import { useT } from "../../i18n";

// -- Style Imports --
import styles from "./SplitBody.module.css";

/** The silence-detection defaults a re-run uses; the tuning knobs are the cropper's. */
const DEFAULT_THRESHOLD_DB = -50;
const DEFAULT_MIN_SILENCE_SECS = 1;

/** The naming pattern a fresh install starts on, matching the backend's own default. */
const DEFAULT_PATTERN = "{track_no} - {title}";

/** How far either side of a cut the play-across preview auditions. */
const ACROSS_PAD_SECS = 2;

/** Which screen the body shows: the editing surface, the live run, or the done report. */
type SubPhase = "editing" | "running" | "done";

/** Where the add-to-library action sits: unstarted, indexing, or done. */
type AddState = "idle" | "adding" | "added";

/** Clamps seconds into the file's playable range. */
function clampSecs(secs: number, durationSecs: number): number {
  return Math.min(durationSecs, Math.max(0, secs));
}

/**
 * The splitter's surface across its three phases. Editing is the waveform lane with its cut markers
 * over the mini-transport and zoom, beside the resizable cut list peek whose foot holds the destination,
 * the collision policy, and the one solid Split CTA. Running is a centered determinate stage; done is a
 * centered report with follow-on actions. The body owns the cut model - N markers to N+1 segments - so
 * it owns the run: it builds the job from the derived segments and drives the phase from the report.
 * A manual edit is tracked so the workbench can guard a close over unsaved cuts.
 */
export function SplitBody({
  analysis,
  path,
  ext,
  dirtyRef,
}: {
  analysis: WaveformAnalysis;
  path: string;
  ext: string;
  dirtyRef?: MutableRefObject<boolean>;
}) {
  const t = useT();
  const { width, containerRef, resizer } = useDrawerResize();

  const [playheadSecs, setPlayheadSecs] = useState(0);
  const [zoom, setZoom] = useState<Zoom>("fit");
  const [hoveredSegmentId, setHoveredSegmentId] = useState<string | null>(null);
  const [selectedSegmentId, setSelectedSegmentId] = useState<string | null>(null);

  const [subPhase, setSubPhase] = useState<SubPhase>("editing");
  const [destination, setDestination] = useState<string | null>(null);
  const [check, setCheck] = useState<DestinationCheck | null>(null);
  const [collision, setCollision] = useState<CollisionPolicy>("rename");
  const [confirmingRun, setConfirmingRun] = useState(false);
  const [runError, setRunError] = useState<string | null>(null);
  const [progress, setProgress] = useState<SpliceProgress | null>(null);
  const [report, setReport] = useState<SpliceReport | null>(null);
  const [addState, setAddState] = useState<AddState>("idle");
  // A hand edit not yet run: a placed, dragged, removed marker, or a typed title or time. Silence and
  // cue seeds do not count, so an untouched auto-seeded state closes without a guard.
  const [touched, setTouched] = useState(false);

  const storedPattern = usePreference(PREF_KEYS.spliceNamingPattern);
  const storedDestination = usePreference(PREF_KEYS.spliceDestination);
  const setPreference = useSetPreference();
  const pattern = storedPattern && storedPattern.length > 0 ? storedPattern : DEFAULT_PATTERN;

  const { sample_rate: sampleRate, total_frames: totalFrames, duration_secs: durationSecs } = analysis;
  const format = spliceFormat(ext);

  const model = useCutModel(totalFrames);
  const addRootPath = useAddRootPath();

  // Seed the markers from the analysis silence once on open: one manual-editable divider per span at
  // its midpoint. The ref guards a re-seed under a callback-identity change or StrictMode's double run.
  const seeded = useRef(false);
  useEffect(() => {
    if (seeded.current) return;
    seeded.current = true;
    if (analysis.silence.length > 0) model.replaceSilence(analysis.silence);
  }, [analysis.silence, model]);

  // Seed the destination from the folder a past split remembered, validating it. With none
  // remembered, open with no destination - a neutral prompt to pick a folder, not an in-library
  // warning on the source's own parent. Re-seeding to the same remembered value is idempotent, so no
  // ref guard (which would leak across StrictMode's setup/cleanup/setup and swallow the validation).
  useEffect(() => {
    if (!storedDestination) return;
    let alive = true;
    setDestination(storedDestination);
    validateExportDestination(storedDestination)
      .then((c) => {
        if (alive) setCheck(c);
      })
      .catch(() => {
        if (alive) setCheck(null);
      });
    return () => {
      alive = false;
    };
  }, [storedDestination]);

  // Publish the close-guard signal: only an unsaved hand edit on the editing surface arms it.
  useEffect(() => {
    if (dirtyRef) dirtyRef.current = subPhase === "editing" && touched;
  }, [dirtyRef, subPhase, touched]);

  const markTouched = useCallback(() => setTouched(true), []);

  const addSnapped = (frame: number) => {
    markTouched();
    model.addMarker(snapFrame(frame, format, sampleRate), "manual");
  };

  const onMoveMarker = (id: string, frame: number) => {
    markTouched();
    model.moveMarker(id, snapFrame(frame, format, sampleRate));
  };

  const onRemoveMarker = (id: string) => {
    markTouched();
    model.removeMarker(id);
  };

  const onSetMeta = (leadingId: string, title: string | undefined) => {
    markTouched();
    model.setSegmentMeta(leadingId, { title });
  };

  const onFindSilences = async () => {
    try {
      const spans = await spliceDetectSilence(path, DEFAULT_THRESHOLD_DB, DEFAULT_MIN_SILENCE_SECS);
      model.replaceSilence(spans);
    } catch {
      // A detect failure leaves the current markers in place; the source already analyzed on open.
    }
  };

  const onImportCue = async () => {
    const cuePath = await pickCueFile();
    if (!cuePath) return;
    try {
      const sheet = await spliceParseCue(cuePath);
      model.replaceCue(sheet, sampleRate);
    } catch {
      // A malformed cue leaves the current markers untouched.
    }
  };

  const onAddAtPlayhead = () => addSnapped(Math.round(playheadSecs * sampleRate));

  const onPlayAcross = (frame: number) => {
    const at = frame / sampleRate;
    void playerPreview(
      path,
      clampSecs(at - ACROSS_PAD_SECS, durationSecs),
      clampSecs(at + ACROSS_PAD_SECS, durationSecs),
    ).catch(() => {});
  };

  const onPickDestination = useCallback(async () => {
    const picked = await pickFolder();
    if (!picked) return;
    setDestination(picked);
    setConfirmingRun(false);
    setRunError(null);
    try {
      const c = await validateExportDestination(picked);
      setCheck(c);
      // Remember a folder the cutter is actually allowed to write to, so the next split opens on it.
      if (c.ok) setPreference(PREF_KEYS.spliceDestination, picked);
    } catch {
      setCheck(null);
    }
  }, [setPreference]);

  const runSplice = useCallback(async () => {
    if (!destination || model.segments.length < 2) return;
    setConfirmingRun(false);
    setRunError(null);
    setProgress(null);
    setReport(null);
    setAddState("idle");
    // A run acts on the cuts, so the unsaved-edits flag clears; a later edit re-arms it.
    setTouched(false);
    setSubPhase("running");

    const channel = createSpliceChannel((tick) => {
      // completed is monotonic within a phase; guard an out-of-order tick from regressing the bar.
      setProgress((prev) => {
        const completed =
          prev && prev.phase === tick.phase ? Math.max(prev.completed, tick.completed) : tick.completed;
        return { ...tick, completed };
      });
    });

    const job: SpliceJob = {
      source_path: path,
      segments: toJobSegments(model.segments),
      destination,
      naming_pattern: pattern,
      collision,
      // The splitter overlays each piece's own title, artist and number over the inherited source tag.
      keep_source_tags: false,
    };

    try {
      setReport(await spliceRun(job, channel));
      setSubPhase("done");
    } catch {
      // The source is read-only, so a failed run leaves it untouched; drop back to editing with the reason.
      setRunError(t((d) => d.splice.runFailed));
      setSubPhase("editing");
    }
  }, [destination, model.segments, path, pattern, collision, t]);

  const onRunClick = useCallback(() => {
    if (check?.non_empty) setConfirmingRun(true);
    else void runSplice();
  }, [check, runSplice]);

  // Bring the written cuts into the library: index their folder as a root, the same ingest a picked
  // folder runs. User-initiated, and only when at least one file landed.
  const onAddToLibrary = useCallback(() => {
    if (!destination) return;
    setAddState("adding");
    void addRootPath(destination)
      .then((ok) => setAddState(ok ? "added" : "idle"))
      .catch(() => setAddState("idle"));
  }, [destination, addRootPath]);

  const onSplitAgain = useCallback(() => {
    setReport(null);
    setProgress(null);
    setRunError(null);
    setConfirmingRun(false);
    setAddState("idle");
    setSubPhase("editing");
  }, []);

  const snapNote =
    format === "mp3"
      ? t((d) => d.splice.snapMp3)
      : format === "flac"
        ? t((d) => d.splice.snapFlac)
        : format === "m4a"
          ? t((d) => d.splice.snapM4a)
          : format === "opus"
            ? t((d) => d.splice.snapOpus)
            : null;

  if (subPhase === "running") {
    const total = progress?.total ?? model.segments.length;
    const completed = progress?.completed ?? 0;
    const errors = progress?.errors ?? 0;
    const value = total > 0 ? completed / total : null;
    return (
      <CenteredStage>
        <div className={styles.centered}>
          <StaffSpinner />
          <h1 className={styles.title}>{t((d) => d.splice.splitting)}</h1>
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
            {/* Making an album straight from the written files needs a backend that indexes and groups
                them in one step; until it lands the action stands disabled, naming what it will do. */}
            <Tooltip label={t((d) => d.splice.createAlbumSoon)}>
              <span className={styles.disabledWrap}>
                <QuietButton disabled>
                  {t((d) => d.splice.createAlbumFrom, { n: report.written })}
                </QuietButton>
              </span>
            </Tooltip>
            {destination ? (
              <QuietButton onClick={() => void openFolder(destination)}>
                {t((d) => d.export.openFolder)}
              </QuietButton>
            ) : null}
            <QuietButton onClick={onSplitAgain}>{t((d) => d.splice.splitAgain)}</QuietButton>
          </div>
        </div>
      </CenteredStage>
    );
  }

  return (
    <div
      className={styles.body}
      ref={containerRef}
      style={{ "--drawer-width": `${width}px` } as CSSProperties}
    >
      <div className={styles.main}>
        <div className={styles.laneWrap}>
          <WaveformLane
            peaks={analysis.peaks}
            silence={analysis.silence}
            totalFrames={totalFrames}
            durationSecs={durationSecs}
            playheadSecs={playheadSecs}
            zoom={zoom}
            onScrub={setPlayheadSecs}
            edit={{
              markers: model.markers,
              segments: model.segments,
              onAddMarker: addSnapped,
              onRemoveMarker,
              onMoveMarker,
              onPlayAcross,
              hoveredSegmentId,
              selectedSegmentId,
              onHoverSegment: setHoveredSegmentId,
            }}
          />
        </div>

        <div className={styles.controls}>
          <MiniTransport
            path={path}
            playheadSecs={playheadSecs}
            durationSecs={durationSecs}
            onPlayhead={setPlayheadSecs}
          />
          <ZoomControl zoom={zoom} onZoom={setZoom} />
        </div>

        <div className={styles.sources}>
          <QuietButton onClick={onAddAtPlayhead}>
            <MapPin size={15} strokeWidth={1.8} />
            <span>{t((d) => d.splice.addMarker)}</span>
          </QuietButton>
          <QuietButton onClick={() => void onFindSilences()}>
            <ScanLine size={15} strokeWidth={1.8} />
            <span>{t((d) => d.splice.findSilences)}</span>
          </QuietButton>
          <QuietButton onClick={() => void onImportCue()}>
            <FileMusic size={15} strokeWidth={1.8} />
            <span>{t((d) => d.splice.importCue)}</span>
          </QuietButton>
        </div>
      </div>

      <div className={styles.panel}>
        <Resizer resizer={resizer} />
        <CutList
          segments={model.segments}
          pattern={pattern}
          onPattern={(next) =>
            setPreference(PREF_KEYS.spliceNamingPattern, next.length > 0 ? next : DEFAULT_PATTERN)
          }
          ext={ext}
          format={format}
          sampleRate={sampleRate}
          path={path}
          hoveredSegmentId={hoveredSegmentId}
          selectedSegmentId={selectedSegmentId}
          onHover={setHoveredSegmentId}
          onSelect={(id) => setSelectedSegmentId((cur) => (cur === id ? null : id))}
          onSetMeta={onSetMeta}
          onMoveMarker={onMoveMarker}
          snapNote={snapNote}
          foot={
            <SpliceOutputConfig
              destination={destination}
              check={check}
              collision={collision}
              segmentCount={model.segments.length}
              confirming={confirmingRun}
              runError={runError}
              onPickDestination={() => void onPickDestination()}
              onCollision={setCollision}
              onRun={onRunClick}
              onConfirmRun={() => void runSplice()}
              onCancelConfirm={() => setConfirmingRun(false)}
            />
          }
        />
      </div>
    </div>
  );
}
