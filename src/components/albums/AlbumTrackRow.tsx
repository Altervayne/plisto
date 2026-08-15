// -- Framework Imports --
import type { MouseEvent } from "react";

// -- Library Imports --
import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";

// -- Component Imports --
import { EditableField } from "../common/EditableField/EditableField";
import { Tooltip } from "../common/Tooltip/Tooltip";

// -- Icon Imports --
import { ArrowUpToLine, GripVertical } from "lucide-react";

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

/** The filename without its extension: everything before the last dot, or the whole name when it has none. */
function filenameStem(filename: string): string {
  const dot = filename.lastIndexOf(".");
  return dot > 0 ? filename.slice(0, dot) : filename;
}

/**
 * One track row in the drawer: a grip handle, a quiet disc field, the per-disc number, the clean title
 * over its mono source filename, and the duration. The handle carries the drag listeners so the title's
 * `EditableField` stays independently editable. The clean title edits `title_override ?? raw_title`;
 * committing empty or the raw value itself clears the override back to raw, so the edited marker only
 * shows a real change. The disc field dissolves until touched: typing a disc moves the track there and
 * renumbers, leaving the album's other discs in place. `displayNo` is the row's position on its disc.
 * The number cell doubles as the selection affordance: it swaps to a checkbox on row hover, or whenever
 * the album has a selection active, so a multi-select never adds a permanent column.
 *
 * `onOpen` switches the row to browse mode for the full-pane view: the title becomes a display button
 * that opens the track's peek, and a click anywhere on the main column opens it too. The grip, disc,
 * and checkbox sit outside that column, so they never open the peek. Without `onOpen` the row keeps its
 * drawer form, the inline title `EditableField`. `peeked` marks the row whose peek is open.
 */
export function AlbumTrackRow({
  row,
  displayNo,
  showDisc,
  selected,
  selecting,
  peeked,
  onSetDisc,
  onToggleSelect,
  onOpen,
}: {
  row: AlbumTrackRowData;
  displayNo: number;
  showDisc: boolean;
  selected: boolean;
  selecting: boolean;
  peeked?: boolean;
  onSetDisc: (disc: number | null) => void;
  onToggleSelect: (mods: { shift: boolean; meta: boolean }) => void;
  onOpen?: () => void;
}) {
  const commit = useCommitTrackOverrides();
  const t = useT();
  const raw = row.raw_title ?? "";
  const edited = row.title_override != null;

  // The resolved title for browse mode's static label; a blank override and blank raw fall to the filename.
  const resolved = row.title_override ?? row.raw_title;
  const displayTitle = resolved != null && resolved !== "" ? resolved : row.filename;

  // The checkbox owns its click: keep it from starting a drag or opening the title field.
  const onCheck = (e: MouseEvent) => {
    e.stopPropagation();
    onToggleSelect({ shift: e.shiftKey, meta: e.metaKey || e.ctrlKey });
  };

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

  // Seeds the clean title from the filename with its extension stripped, through the same override path
  // as a typed title - so it reflects at once and reverts like any other edit. This is the album-list
  // reach for the filename, the place it is most often the only source of a real title.
  const useFilenameAsTitle = () =>
    commit(row.album_id, row.track_id, { ...override, title_override: filenameStem(row.filename) });

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
      className={showDisc ? `${styles.row} ${styles.withDisc}` : styles.row}
      data-missing={row.missing_at != null ? "" : undefined}
      data-dragging={isDragging ? "" : undefined}
      data-selected={selected ? "" : undefined}
      data-selecting={selecting ? "" : undefined}
      data-peeked={peeked ? "" : undefined}
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

      {showDisc ? (
        <div className={styles.disc}>
          <EditableField
            value={String(discOf(row))}
            ariaLabel={t((d) => d.tracks.fields.discNo)}
            onCommit={onDisc}
          />
        </div>
      ) : null}

      <div className={styles.numCell}>
        <span className={styles.no}>{displayNo}</span>
        <button
          type="button"
          className={styles.check}
          role="checkbox"
          aria-checked={selected}
          aria-label={selected ? t((d) => d.tracks.deselectTrack) : t((d) => d.tracks.selectTrack)}
          onClick={onCheck}
        >
          <span className={styles.tick} aria-hidden="true" />
        </button>
      </div>

      {onOpen ? (
        <div className={`${styles.main} ${styles.openMain}`} onClick={onOpen}>
          <button type="button" className={styles.openTitle} onClick={onOpen}>
            {displayTitle}
          </button>
          <div className={styles.rawline}>
            <Tooltip label={row.filename}>
              <span className={styles.source}>{row.filename}</span>
            </Tooltip>
            {edited ? (
              <span className={styles.editedMark}>{t((d) => d.common.edited)}</span>
            ) : null}
          </div>
        </div>
      ) : (
        <div className={styles.main}>
          <EditableField
            value={row.title_override ?? row.raw_title ?? ""}
            ariaLabel={t((d) => d.albums.trackTitle)}
            placeholder={row.filename}
            onCommit={onTitle}
          />
          <div className={styles.rawline}>
            <Tooltip label={row.filename}>
              <span className={styles.source}>{row.filename}</span>
            </Tooltip>
            {edited ? (
              <>
                <span className={styles.editedMark}>{t((d) => d.common.edited)}</span>
                <button type="button" className={styles.revert} onClick={revert}>
                  {t((d) => d.common.revert)}
                </button>
              </>
            ) : null}
            <Tooltip label={t((d) => d.tracks.useFilenameAsTitle)}>
              <button
                type="button"
                className={styles.useName}
                onClick={useFilenameAsTitle}
                aria-label={t((d) => d.tracks.useFilenameAsTitle)}
              >
                <ArrowUpToLine size={13} strokeWidth={1.8} />
              </button>
            </Tooltip>
          </div>
        </div>
      )}

      <span className={styles.dur}>{formatDuration(row.duration_secs)}</span>
    </div>
  );
}
