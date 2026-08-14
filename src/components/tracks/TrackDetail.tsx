// -- Framework Imports --
import { useEffect } from "react";

// -- Component Imports --
import { ScrollArea } from "../common/ScrollArea/ScrollArea";
import { QuietButton } from "../common/QuietButton";
import { TrackDetailCover } from "./TrackDetailCover";

// -- Utils Imports --
import { formatBytes, formatDuration, formatTimestamp } from "../../lib/format";

// -- Type Imports --
import type { TrackRow } from "../../types";

// -- i18n Imports --
import { useT } from "../../i18n";
import type { Translate } from "../../i18n";

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
function fieldsOf(track: TrackRow, t: Translate): DetailField[] {
  return [
    { label: t((d) => d.tracks.fields.title), value: show(track.raw_title) },
    { label: t((d) => d.tracks.fields.artist), value: show(track.raw_artist) },
    { label: t((d) => d.tracks.fields.album), value: show(track.raw_album) },
    { label: t((d) => d.tracks.fields.albumArtist), value: show(track.raw_album_artist) },
    { label: t((d) => d.tracks.fields.trackNo), value: show(track.raw_track_no) },
    { label: t((d) => d.tracks.fields.discNo), value: show(track.raw_disc_no) },
    { label: t((d) => d.tracks.fields.year), value: show(track.raw_year) },
    { label: t((d) => d.tracks.fields.genre), value: show(track.raw_genre) },
    { label: t((d) => d.tracks.fields.length), value: formatDuration(track.duration_secs) },
    { label: t((d) => d.tracks.fields.format), value: track.ext.toUpperCase() },
    { label: t((d) => d.tracks.fields.size), value: formatBytes(track.size_bytes) },
    { label: t((d) => d.tracks.fields.modified), value: formatTimestamp(track.mtime) },
    { label: t((d) => d.tracks.fields.indexed), value: formatTimestamp(track.scanned_at) },
    { label: t((d) => d.tracks.fields.filename), value: track.filename, mono: true },
    { label: t((d) => d.tracks.fields.sourcePath), value: track.source_path, mono: true },
  ];
}

/**
 * The read-only peek for one track: every raw field, including the tags kept out of the grid and
 * the full source path. A continuous-surface side region held by the edge veil, never a framed
 * panel. Dismiss with the close button or Escape.
 */
export function TrackDetail({ track, onClose }: { track: TrackRow; onClose: () => void }) {
  const t = useT();

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === "Escape") onClose();
    };
    document.addEventListener("keydown", onKey);
    return () => document.removeEventListener("keydown", onKey);
  }, [onClose]);

  return (
    <aside className={styles.drawer} aria-label={t((d) => d.tracks.details)}>
      <ScrollArea className={styles.scroll} contentClassName={styles.inner}>
        <div className={styles.head}>
          <h2 className={styles.title}>{track.raw_title ?? track.filename}</h2>
          <QuietButton onClick={onClose} aria-label={t((d) => d.common.closeDetails)}>
            {t((d) => d.common.close)}
          </QuietButton>
        </div>
        <TrackDetailCover track={track} />
        <dl className={styles.fields}>
          {fieldsOf(track, t).map((field) => (
            <div className={styles.field} key={field.label}>
              <dt className={styles.label}>{field.label}</dt>
              <dd className={`${styles.value} ${field.mono ? styles.mono : ""}`}>{field.value}</dd>
            </div>
          ))}
        </dl>
      </ScrollArea>
    </aside>
  );
}
