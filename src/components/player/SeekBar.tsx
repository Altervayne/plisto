// -- Framework Imports --
import { useRef, useState } from "react";

// -- Library Imports --
import type { CSSProperties, KeyboardEvent, PointerEvent } from "react";

// -- Format Imports --
import { formatDuration } from "../../lib/format";

// -- i18n Imports --
import { useT } from "../../i18n";

// -- Style Imports --
import styles from "./SeekBar.module.css";

/** How far the arrow keys nudge the playhead, in seconds. */
const KEY_STEP = 5;

/** Clamps a ratio into 0..1. */
function clamp01(v: number): number {
  return Math.min(1, Math.max(0, v));
}

/**
 * The scrubbable playhead: a thin track with an accent fill, a handle that surfaces on hover or
 * focus, and the elapsed / total times below. Built on the ProgressLine track/fill vocabulary.
 *
 * Commit-on-release: a drag holds a local position and paints the fill and handle from it, ignoring
 * the incoming prop so the engine's ticks never fight the thumb, then seeks once on release. A track
 * with no known length renders inert - there is nowhere to seek to. Keyboard: arrows nudge, Home/End
 * jump to the ends, each seeking at once.
 */
export function SeekBar({
  position,
  duration,
  onSeek,
}: {
  position: number;
  duration: number;
  onSeek: (secs: number) => void;
}) {
  const t = useT();
  const railRef = useRef<HTMLDivElement>(null);
  // The dragged position, or null when not scrubbing. While set it drives the fill and handle, so the
  // thumb tracks the pointer rather than the engine's live position underneath it.
  const [scrubbing, setScrubbing] = useState<number | null>(null);

  const known = duration > 0;
  const value = scrubbing ?? position;
  const pct = known ? clamp01(value / duration) * 100 : 0;

  // The seconds under the pointer, from its x within the rail.
  const secsFromPointer = (e: PointerEvent<HTMLDivElement>): number => {
    const rail = railRef.current;
    if (!rail) return 0;
    const rect = rail.getBoundingClientRect();
    return clamp01((e.clientX - rect.left) / rect.width) * duration;
  };

  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    if (!known) return;
    const secs = secsFromPointer(e);
    setScrubbing(secs);
    railRef.current?.setPointerCapture(e.pointerId);
  };

  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    if (scrubbing == null) return;
    setScrubbing(secsFromPointer(e));
  };

  const onPointerUp = (e: PointerEvent<HTMLDivElement>) => {
    if (scrubbing == null) return;
    const secs = secsFromPointer(e);
    railRef.current?.releasePointerCapture(e.pointerId);
    setScrubbing(null);
    onSeek(secs);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    if (!known) return;
    switch (e.key) {
      case "ArrowLeft":
        e.preventDefault();
        onSeek(Math.max(0, position - KEY_STEP));
        break;
      case "ArrowRight":
        e.preventDefault();
        onSeek(Math.min(duration, position + KEY_STEP));
        break;
      case "Home":
        e.preventDefault();
        onSeek(0);
        break;
      case "End":
        e.preventDefault();
        onSeek(duration);
        break;
      default:
        break;
    }
  };

  return (
    <div className={styles.seek}>
      <div
        ref={railRef}
        className={styles.rail}
        style={{ "--pct": `${pct}%` } as CSSProperties}
        role="slider"
        tabIndex={known ? 0 : -1}
        aria-label={t((d) => d.player.seek)}
        aria-valuemin={0}
        aria-valuemax={known ? Math.round(duration) : 0}
        aria-valuenow={Math.round(value)}
        aria-valuetext={formatDuration(value)}
        aria-disabled={known ? undefined : true}
        data-scrubbing={scrubbing != null ? "" : undefined}
        data-inert={known ? undefined : ""}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onKeyDown={onKeyDown}
      >
        <div className={styles.track}>
          <div className={styles.fill} />
        </div>
        <div className={styles.handle} aria-hidden="true" />
      </div>
      <div className={styles.times}>
        <span className={`${styles.time} tabular`}>{formatDuration(value)}</span>
        <span className={`${styles.time} tabular`}>{formatDuration(known ? duration : null)}</span>
      </div>
    </div>
  );
}
