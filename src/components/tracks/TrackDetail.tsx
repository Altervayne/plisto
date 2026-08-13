// -- Framework Imports --
import { useEffect } from "react";

// -- Component Imports --
import { QuietButton } from "../common/QuietButton";

// -- Utils Imports --
import { formatBytes, formatDuration, formatTimestamp } from "../../lib/format";

// -- Type Imports --
import type { TrackRow } from "../../types";

// -- Style Imports --
import styles from "./TrackDetail.module.css";

/** One labelled field in the peek. A mono value marks a raw, messy original (filename, path). */
interface DetailField {
  label: string;
  value: string;
  mono?: boolean;
}

/** Renders a raw value for display, folding an absent one to a deliberate dash. */
function show(value: string | number | null): string {
  if (value == null || value === "") return "-";
  return String(value);
}

/** Every raw field of a track, in reading order: the tags first, then the file facts, then paths. */
function fieldsOf(track: TrackRow): DetailField[] {
  return [
    { label: "Title", value: show(track.raw_title) },
    { label: "Artist", value: show(track.raw_artist) },
    { label: "Album", value: show(track.raw_album) },
    { label: "Album artist", value: show(track.raw_album_artist) },
    { label: "Track no", value: show(track.raw_track_no) },
    { label: "Disc no", value: show(track.raw_disc_no) },
    { label: "Year", value: show(track.raw_year) },
    { label: "Genre", value: show(track.raw_genre) },
    { label: "Length", value: formatDuration(track.duration_secs) },
    { label: "Format", value: track.ext.toUpperCase() },
    { label: "Size", value: formatBytes(track.size_bytes) },
    { label: "Modified", value: formatTimestamp(track.mtime) },
    { label: "Indexed", value: formatTimestamp(track.scanned_at) },
    { label: "Filename", value: track.filename, mono: true },
    { label: "Source path", value: track.source_path, mono: true },
  ];
}

/**
 * The read-only peek for one track: every raw field, including the tags kept out of the grid and
 * the full source path. A continuous-surface side region held by the edge veil, never a framed
 * panel. Dismiss with the close button or Escape.
 */
export function TrackDetail({ track, onClose }: { track: TrackRow; onClose: () => void }) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <aside className={styles.drawer} aria-label="Track details">
      <div className={styles.head}>
        <h2 className={styles.title}>{track.raw_title ?? track.filename}</h2>
        <QuietButton onClick={onClose} aria-label="Close details">
          Close
        </QuietButton>
      </div>
      <dl className={styles.fields}>
        {fieldsOf(track).map((field) => (
          <div className={styles.field} key={field.label}>
            <dt className={styles.label}>{field.label}</dt>
            <dd className={`${styles.value} ${field.mono ? styles.mono : ""}`}>{field.value}</dd>
          </div>
        ))}
      </dl>
    </aside>
  );
}
