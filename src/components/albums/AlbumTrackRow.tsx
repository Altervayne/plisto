// -- Component Imports --
import { EditableField } from "../common/EditableField/EditableField";

// -- State Imports --
import { useCommitTrackOverrides } from "../../state/organize/store";

// -- Utils Imports --
import { formatDuration } from "../../lib/format";

// -- Type Imports --
import type { AlbumTrackRow as AlbumTrackRowData, TrackOverride } from "../../types";

// -- Style Imports --
import styles from "./AlbumTrackRow.module.css";

/**
 * One track row in the drawer: the number, the clean title over its mono source filename, and the
 * duration. The clean title edits `title_override ?? raw_title`; committing empty or the raw value
 * itself clears the override back to raw, so the edited marker only shows a real change. The raw
 * filename stays beneath as the messy original, with a quiet revert-to-raw when an override is set.
 */
export function AlbumTrackRow({ row }: { row: AlbumTrackRowData }) {
  const commit = useCommitTrackOverrides();
  const raw = row.raw_title ?? "";
  const edited = row.title_override != null;

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
    <div className={styles.row} data-missing={row.missing_at != null ? "" : undefined}>
      <span className={styles.no}>{row.track_no ?? "-"}</span>

      <div className={styles.main}>
        <EditableField
          value={row.title_override ?? row.raw_title ?? ""}
          ariaLabel="Track title"
          placeholder={row.filename}
          onCommit={onTitle}
        />
        <div className={styles.rawline}>
          <span className={styles.source}>{row.filename}</span>
          {edited ? (
            <>
              <span className={styles.editedMark}>edited</span>
              <button type="button" className={styles.revert} onClick={revert}>
                revert
              </button>
            </>
          ) : null}
        </div>
      </div>

      <span className={styles.dur}>{formatDuration(row.duration_secs)}</span>
    </div>
  );
}
