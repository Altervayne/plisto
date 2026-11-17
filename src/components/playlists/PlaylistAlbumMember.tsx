// -- Component Imports --
import { Tooltip } from "../common/Tooltip/Tooltip";

// -- Icon Imports --
import { Play, TriangleAlert } from "lucide-react";

// -- Format Imports --
import { formatDuration } from "../../lib/format";

// -- Utils Imports --
import { memberTitle } from "./albumEntryPlay";

// -- Type Imports --
import type { AlbumTrackRow } from "../../types";

// -- i18n Imports --
import { useT } from "../../i18n";

// -- Style Imports --
import styles from "./PlaylistAlbumMember.module.css";

/**
 * One member of an unfolded album entry: its number, title and length, read-only. The number swaps to a
 * play triangle on hover that starts the playlist at this track; absent `onPlay`, no triangle. A member
 * whose file is gone keeps its place, tagged, with the triangle greyed and the reason on hover.
 */
export function PlaylistAlbumMember({
  member,
  no,
  onPlay,
}: {
  member: AlbumTrackRow;
  no: number;
  onPlay?: () => void;
}) {
  const t = useT();
  const missing = member.missing_at != null;

  const glyph = (
    <span
      className={missing ? `${styles.play} ${styles.playOff}` : styles.play}
      aria-hidden="true"
      onClick={(e) => {
        e.stopPropagation();
        if (!missing) onPlay?.();
      }}
    >
      <Play size={12} strokeWidth={2} fill="currentColor" />
    </span>
  );

  return (
    <div className={styles.row} data-missing={missing ? "" : undefined}>
      <span className={styles.numCell}>
        <span className={styles.no}>{no}</span>
        {onPlay ? missing ? <Tooltip label={t((d) => d.player.fileMissing)}>{glyph}</Tooltip> : glyph : null}
      </span>
      <span className={styles.title}>
        <span className={styles.titleText}>{memberTitle(member)}</span>
        {missing ? (
          <span className={styles.tag}>
            <TriangleAlert size={12} strokeWidth={1.8} aria-hidden="true" />
            {t((d) => d.playlists.albumEntry.fileMissing)}
          </span>
        ) : null}
      </span>
      <span className={`${styles.duration} tabular`}>{missing ? "-" : formatDuration(member.duration_secs)}</span>
    </div>
  );
}
