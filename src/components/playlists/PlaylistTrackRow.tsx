// -- Library Imports --
import { useSortable } from "@dnd-kit/sortable";
import { CSS } from "@dnd-kit/utilities";

// -- Component Imports --
import { Tooltip } from "../common/Tooltip/Tooltip";
import { ContextMenu, useContextMenu } from "../common/ContextMenu";

// -- Icon Imports --
import { GripVertical, Play, X } from "lucide-react";

// -- State Imports --
import { useTrack } from "../../state/store";

// -- Type Imports --
import type { MenuEntry } from "../common/ContextMenu";
import type { PlaylistTrackRow as PlaylistTrackRowData } from "../../types";

// -- i18n Imports --
import { useT } from "../../i18n";

// -- Style Imports --
import styles from "./PlaylistTrackRow.module.css";

/**
 * One slot row in the full-pane playlist: a grip handle, the position number, the title over its mono
 * filename, and a hover-revealed remove. The handle carries the drag listeners so the main column stays
 * an independent open target. Clicking the main column opens the track peek. `peeked` marks the row whose
 * peek is open.
 *
 * The title reads live off the library track (`title_edit ?? raw_title`), so an edit made in the peek
 * reflects at once, while the slot still owns identity and position. A track with no title shows a faint
 * streak rather than echoing the filename already on the line beneath. The remove keys on the slot id, so
 * a repeated track drops one copy at a time.
 *
 * The number cell doubles as the play affordance: at rest the position shows; on row hover it swaps to an
 * accent play triangle by opacity alone, playing the track through the list's queue. A slot whose source
 * is gone or whose format is undecodable shows the triangle greyed and inert, with the reason on hover.
 * `buildMenu` arms the right-click menu, the keyboard route the hover triangle cannot be; absent, no menu.
 */
export function PlaylistTrackRow({
  slot,
  displayNo,
  peeked,
  onOpen,
  onRemove,
  onPlay,
  buildMenu,
}: {
  slot: PlaylistTrackRowData;
  displayNo: number;
  peeked: boolean;
  onOpen: () => void;
  onRemove: () => void;
  onPlay?: () => void;
  buildMenu?: () => MenuEntry[];
}) {
  const live = useTrack(slot.track_id);
  const t = useT();
  const menu = useContextMenu();

  // Prefer the live edit layer so a peek edit reflects at once; fall back to the slot's own projection
  // when the track is not in the store.
  const resolved = live ? (live.title_edit ?? live.raw_title) : (slot.title ?? slot.raw_title);
  const untitled = resolved == null || resolved === "";
  const fullPath = slot.display_path ?? slot.source_path;

  // The source is gone, or the format is one the engine will not decode: the triangle greys and the
  // click is dead, with the reason carried on hover. The slot has no ext, so read it off the filename.
  const playable = slot.missing_at == null && !slot.filename.toLowerCase().endsWith(".opus");
  const playReason =
    slot.missing_at != null
      ? t((d) => d.player.fileMissing)
      : t((d) => d.player.unsupportedFormat);
  const playGlyph = (
    <span
      className={playable ? styles.play : `${styles.play} ${styles.playOff}`}
      aria-hidden="true"
      onClick={(e) => {
        e.stopPropagation();
        if (playable) onPlay?.();
      }}
    >
      <Play size={12} strokeWidth={2} fill="currentColor" />
    </span>
  );
  const playControl = playable ? playGlyph : <Tooltip label={playReason}>{playGlyph}</Tooltip>;

  const { attributes, listeners, setNodeRef, transform, transition, isDragging } = useSortable({
    id: slot.id,
  });
  const style = { transform: CSS.Transform.toString(transform), transition };

  return (
    <div
      ref={setNodeRef}
      style={style}
      className={styles.row}
      data-missing={slot.missing_at != null ? "" : undefined}
      data-dragging={isDragging ? "" : undefined}
      data-peeked={peeked ? "" : undefined}
      onContextMenu={buildMenu ? menu.onContextMenu : undefined}
    >
      <button
        type="button"
        className={styles.handle}
        aria-label={t((d) => d.playlists.reorderTrack)}
        {...attributes}
        {...listeners}
      >
        <GripVertical size={16} strokeWidth={1.8} />
      </button>

      <div className={styles.numCell}>
        <span className={styles.no}>{displayNo}</span>
        {onPlay ? playControl : null}
      </div>

      <div className={styles.main} onClick={onOpen}>
        <button
          type="button"
          className={styles.title}
          data-untitled={untitled ? "" : undefined}
          aria-label={untitled ? slot.filename : undefined}
          onClick={onOpen}
        >
          {untitled ? <span className={styles.streak} aria-hidden="true" /> : resolved}
        </button>
        <Tooltip label={fullPath}>
          <span className={styles.source}>{slot.filename}</span>
        </Tooltip>
      </div>

      <button
        type="button"
        className={styles.remove}
        aria-label={t((d) => d.playlists.removeTrack)}
        onClick={onRemove}
      >
        <X size={15} strokeWidth={1.8} />
      </button>

      {buildMenu ? (
        <ContextMenu
          open={menu.open}
          x={menu.x}
          y={menu.y}
          onClose={menu.close}
          items={buildMenu()}
          ariaLabel={untitled ? slot.filename : (resolved as string)}
        />
      ) : null}
    </div>
  );
}
