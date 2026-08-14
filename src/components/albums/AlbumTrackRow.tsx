// -- Library Imports --
import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";

// -- Component Imports --
import { EditableField } from "../common/EditableField/EditableField";

// -- Icon Imports --
import { GripVertical } from "lucide-react";

// -- State Imports --
import { useCommitTrackOverrides } from "../../state/organize/store";

// -- Utils Imports --
import { discOf } from "./albumLayout";
import { parseDisc } from "./discField";
import { formatDuration } from "../../lib/format";

// -- Type Imports --
import type { AlbumTrackRow as AlbumTrackRowData, TrackOverride } from "../../types";

// -- i18n Imports --
import { useT } from "../../i18n";

// -- Style Imports --
import styles from "./AlbumTrackRow.module.css";

/**
 * One track row in the drawer: a grip handle, a quiet disc field, the per-disc number, the clean title
 * over its mono source filename, and the duration. The handle carries the drag listeners so the title's
 * `EditableField` stays independently editable. The clean title edits `title_override ?? raw_title`;
 * committing empty or the raw value itself clears the override back to raw, so the edited marker only
 * shows a real change. The disc field dissolves until touched: typing a disc moves the track there and
 * renumbers, leaving the album's other discs in place. `displayNo` is the row's position on its disc.
 */
export function AlbumTrackRow({
  row,
  displayNo,
  onSetDisc,
}: {
  row: AlbumTrackRowData;
  displayNo: number;
  onSetDisc: (disc: number | null) => void;
}) {
  const commit = useCommitTrackOverrides();
  const t = useT();
  const raw = row.raw_title ?? "";
  const edited = row.title_override != null;

  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: row.track_id,
  });
  const style = { transform: CSS.Transform.toString(transform), transition };

  const override: TrackOverride = {
    title_override: row.title_override,
    artist_override: row.artist_override,
    track_no: row.track_no,
    disc_no: row.disc_no,
  };

  const onTitle = (next: string) => {
    const title = next === "" || next === raw ? null : next;
    commit(row.album_id, row.track_id, { ...override, title_override: title });
  };

  const revert = () => commit(row.album_id, row.track_id, { ...override, title_override: null });

  // A typed disc that lands on the track's current disc changes nothing; only a real move renumbers.
  const onDisc = (next: string) => {
    const disc = parseDisc(next);
    if ((disc ?? 1) === discOf(row)) return;
    onSetDisc(disc);
  };

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={styles.row}
      data-missing={row.missing_at != null ? "" : undefined}
      data-dragging={isDragging ? "" : undefined}
    >
      <button
        type="button"
        className={styles.handle}
        aria-label={t((d) => d.albums.reorderTrack)}
        {...attributes}
        {...listeners}
      >
        <GripVertical size={16} strokeWidth={1.8} />
      </button>

      <div className={styles.disc}>
        <EditableField
          value={String(discOf(row))}
          ariaLabel={t((d) => d.tracks.fields.discNo)}
          onCommit={onDisc}
        />
      </div>

      <span className={styles.no}>{displayNo}</span>

      <div className={styles.main}>
        <EditableField
          value={row.title_override ?? row.raw_title ?? ""}
          ariaLabel={t((d) => d.albums.trackTitle)}
          placeholder={row.filename}
          onCommit={onTitle}
        />
        <div className={styles.rawline}>
          <span className={styles.source}>{row.filename}</span>
          {edited ? (
            <>
              <span className={styles.editedMark}>{t((d) => d.albums.edited)}</span>
              <button type="button" className={styles.revert} onClick={revert}>
                {t((d) => d.albums.revert)}
              </button>
            </>
          ) : null}
        </div>
      </div>

      <span className={styles.dur}>{formatDuration(row.duration_secs)}</span>
    </div>
  );
}
