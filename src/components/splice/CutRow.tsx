// -- Icon Imports --
import { Play } from "lucide-react";

// -- Component Imports --
import { EditableField } from "../common/EditableField/EditableField";
import { QuietButton } from "../common/QuietButton";
import { TimeField } from "./TimeField";

// -- Local Imports --
import type { DerivedSegment } from "./cutModel";

// -- IPC Imports --
import { playerPreview } from "../../lib/ipc";

// -- Utils Imports --
import { formatTimecode, projectFilename, snapFrame, type SpliceFormat } from "../../lib/splice";
import { formatDuration } from "../../lib/format";

// -- i18n Imports --
import { useT } from "../../i18n";

// -- Style Imports --
import styles from "./CutRow.module.css";

/**
 * One output row in the cut list: an editable title, the projected filename it lands under, and its
 * start-end times with duration. The times display the format-snapped boundaries (WAV sample-accurate,
 * MP3 on the frame grid, FLAC as requested), and the play control auditions just this segment through
 * the transient preview. A source micro-label marks a silence- or cue-placed row. Hovering or clicking
 * the row drives the shared highlight, so its span lights up on the lane.
 */
export function CutRow({
  index,
  segment,
  pattern,
  ext,
  format,
  sampleRate,
  path,
  active,
  onSetMeta,
  onMoveMarker,
  onHover,
  onSelect,
}: {
  index: number;
  segment: DerivedSegment;
  pattern: string;
  ext: string;
  format: SpliceFormat | null;
  sampleRate: number;
  path: string;
  active: boolean;
  onSetMeta: (leadingId: string, title: string | undefined) => void;
  onMoveMarker: (id: string, frame: number) => void;
  onHover: (id: string | null) => void;
  onSelect: (id: string) => void;
}) {
  const t = useT();

  const start = snapFrame(segment.start, format, sampleRate);
  const end = snapFrame(segment.end, format, sampleRate);
  const durationSecs = sampleRate > 0 ? (end - start) / sampleRate : 0;

  const filename = projectFilename(pattern, segment.meta, index, ext);

  const originLabel =
    segment.leadingOrigin === "silence"
      ? t((d) => d.splice.originSilence)
      : segment.leadingOrigin === "cue"
        ? t((d) => d.splice.originCue)
        : null;

  const onPlay = () =>
    void playerPreview(path, segment.start / sampleRate, segment.end / sampleRate).catch(() => {});

  return (
    <div
      className={`${styles.row} ${active ? styles.active : ""}`}
      onPointerEnter={() => onHover(segment.id)}
      onPointerLeave={() => onHover(null)}
      onClick={() => onSelect(segment.id)}
    >
      <div className={styles.head}>
        <span className={styles.index}>{index + 1}</span>
        <div className={styles.title}>
          <EditableField
            value={segment.meta.title ?? ""}
            ariaLabel={t((d) => d.splice.cutTitle)}
            placeholder={t((d) => d.splice.cutTitlePlaceholder)}
            onCommit={(next) => onSetMeta(segment.id, next === "" ? undefined : next)}
          />
        </div>
        <QuietButton onClick={onPlay} aria-label={t((d) => d.splice.playSegment)}>
          <Play size={14} strokeWidth={1.8} />
        </QuietButton>
      </div>
      <div className={styles.filename}>{filename}</div>
      <div className={styles.meta}>
        <span className={`${styles.times} tabular`}>
          {index === 0 ? (
            formatTimecode(start, sampleRate)
          ) : (
            <TimeField
              frame={start}
              sampleRate={sampleRate}
              onCommit={(frame) => onMoveMarker(segment.id, frame)}
              ariaLabel={t((d) => d.splice.startTime)}
            />
          )}
          {" - "}
          {formatTimecode(end, sampleRate)}
          {" · "}
          {formatDuration(durationSecs)}
        </span>
        {originLabel ? <span className={styles.origin}>{originLabel}</span> : null}
      </div>
    </div>
  );
}
