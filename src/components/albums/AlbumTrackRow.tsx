// -- Library Imports --
import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";

// -- Component Imports --
import { EditableField } from "../common/EditableField/EditableField";

// -- State Imports --
import { useCommitTrackOverrides } from "../../state/organize/store";

// -- Utils Imports --
import { formatDuration } from "../../lib/format";

// -- Type Imports --
import type { AlbumTrackRow as AlbumTrackRowData, TrackOverride } from "../../types";

// -- i18n Imports --
import { useT } from "../../i18n";

// -- Style Imports --
import styles from "./AlbumTrackRow.module.css";

/** Six grip dots: the quiet reorder affordance, distinct from the editable title so a drag never fights an edit. */
function GripDots() {
  return (
    <svg viewBox="0 0 10 16" width="10" height="16" aria-hidden="true" focusable="false">
      <g fill="currentColor">
        <circle cx="2.5" cy="3" r="1.2" />
        <circle cx="7.5" cy="3" r="1.2" />
        <circle cx="2.5" cy="8" r="1.2" />
        <circle cx="7.5" cy="8" r="1.2" />
        <circle cx="2.5" cy="13" r="1.2" />
        <circle cx="7.5" cy="13" r="1.2" />
      </g>
    </svg>
  );
}

/**
 * One track row in the drawer: a grip handle, the number, the clean title over its mono source filename, and
 * the duration. The handle carries the drag listeners so the title's `EditableField` stays independently
 * editable. The clean title edits `title_override ?? raw_title`; committing empty or the raw value itself
 * clears the override back to raw, so the edited marker only shows a real change. The raw filename stays
 * beneath as the messy original, with a quiet revert-to-raw when an override is set.
 */
export function AlbumTrackRow({ row }: { row: AlbumTrackRowData }) {
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
        <GripDots />
      </button>

      <span className={styles.no}>{row.track_no ?? "-"}</span>

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
