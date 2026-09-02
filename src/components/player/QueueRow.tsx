// -- Icon Imports --
import { Play } from "lucide-react";

// -- Component Imports --
import { NowPlayingBars } from "./NowPlayingBars";

// -- Format Imports --
import { formatDuration } from "../../lib/format";

// -- Type Imports --
import type { QueueRowState } from "./queueRowState";

// -- Style Imports --
import styles from "./QueueRow.module.css";

/**
 * One queue row: the number cell, the title over its artist, and the duration. The number cell carries
 * three faces stacked - the position, the equalizer on the now-playing row, and the accent play triangle
 * that surfaces on hover - swapped by opacity so the column never reflows. The triangle is the one
 * sanctioned transient accent; the now-playing fill stays a neutral veil. Clicking the row jumps the
 * engine to it. An empty title falls back to a localized placeholder rather than a blank line.
 */
export function QueueRow({
  state,
  displayNo,
  title,
  artist,
  durationSecs,
  unknownLabel,
  onJump,
}: {
  state: QueueRowState;
  displayNo: number;
  title: string;
  artist: string | null;
  durationSecs: number | null;
  unknownLabel: string;
  onJump: () => void;
}) {
  const shown = title === "" ? unknownLabel : title;

  return (
    <button type="button" className={styles.row} data-state={state} onClick={onJump} aria-label={shown}>
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
  );
}
