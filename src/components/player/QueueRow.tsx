// -- Library Imports --
import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";

// -- Icon Imports --
import { GripVertical, Play, X } from "lucide-react";

// -- Component Imports --
import { NowPlayingBars } from "./NowPlayingBars";

// -- Format Imports --
import { formatDuration } from "../../lib/format";

// -- Type Imports --
import type { QueueRowState } from "./queueRowState";

// -- Style Imports --
import styles from "./QueueRow.module.css";

/**
 * One queue row: a reserved grip lane, the number cell, the title over its artist, and the duration.
 * The number cell carries three faces stacked - the position, the equalizer on the now-playing row, and
 * the accent play triangle that surfaces on hover - swapped by opacity so the column never reflows. The
 * triangle is the one sanctioned transient accent; the now-playing fill stays a neutral veil.
 *
 * An up-next row reveals a grip in the lane and a remove that swaps over the duration on hover; both stop
 * the click from reaching the jump, and neither shows on the played or now-playing rows. The whole
 * central column jumps the engine to this row. An empty title falls back to a localized placeholder
 * rather than a blank line.
 */
export function QueueRow({
  id,
  state,
  displayNo,
  title,
  artist,
  durationSecs,
  unknownLabel,
  reorderLabel,
  removeLabel,
  onJump,
  onRemove,
}: {
  id: string;
  state: QueueRowState;
  displayNo: number;
  title: string;
  artist: string | null;
  durationSecs: number | null;
  unknownLabel: string;
  reorderLabel: string;
  removeLabel: string;
  onJump: () => void;
  onRemove: () => void;
}) {
  const shown = title === "" ? unknownLabel : title;
  const draggable = state === "next";

  // Every row registers for stable geometry, but only up-next rows lift and drag; the played and now
  // rows sit inert so a drop can never land above the cursor.
  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id,
    disabled: !draggable,
  });
  const style = { transform: CSS.Transform.toString(transform), transition };

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={styles.row}
      data-state={state}
      data-dragging={isDragging ? "" : undefined}
    >
      {draggable ? (
        <button
          type="button"
          className={styles.handle}
          aria-label={reorderLabel}
          onClick={(e) => e.stopPropagation()}
          {...attributes}
          {...listeners}
        >
          <GripVertical size={14} strokeWidth={1.8} />
        </button>
      ) : (
        <span className={styles.handleLane} aria-hidden="true" />
      )}

      <button type="button" className={styles.jump} onClick={onJump} aria-label={shown}>
        <span className={styles.numCell}>
          {state === "now" ? (
            <NowPlayingBars />
          ) : (
            <span className={styles.no}>{displayNo}</span>
          )}
          <span className={styles.play} aria-hidden="true">
            <Play size={12} strokeWidth={2} fill="currentColor" />
          </span>
        </span>

        <span className={styles.main}>
          <span className={styles.title} data-untitled={title === "" ? "" : undefined}>
            {shown}
          </span>
          {artist ? <span className={styles.artist}>{artist}</span> : null}
        </span>

        <span className={`${styles.duration} tabular`}>{formatDuration(durationSecs)}</span>
      </button>

      {draggable ? (
        <button
          type="button"
          className={styles.remove}
          aria-label={removeLabel}
          onClick={(e) => {
            e.stopPropagation();
            onRemove();
          }}
        >
          <X size={14} strokeWidth={1.8} />
        </button>
      ) : null}
    </div>
  );
}
