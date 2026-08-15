// -- Framework Imports --
import { useState } from "react";

// -- Component Imports --
import { EditableField } from "../common/EditableField/EditableField";
import { QuietButton } from "../common/QuietButton";
import { Cover } from "../common/Cover/Cover";

// -- Icon Imports --
import { ListMusic, Pencil, Trash2 } from "lucide-react";

// -- Hook Imports --
import { usePlaylistCover } from "./usePlaylistCover";

// -- State Imports --
import { useRemovePlaylist, useRenamePlaylist } from "../../state/playlists/store";

// -- Type Imports --
import type { PlaylistRow as PlaylistRowData } from "../../types";

// -- i18n Imports --
import { useT } from "../../i18n";

// -- Style Imports --
import styles from "./PlaylistRow.module.css";

/**
 * One playlist as a quiet row, twin to the folder and genre rows: no card, warm with the veil on hover.
 * The name reads as a display that opens the playlist on click; a rename glyph swaps it for an inline
 * field, committing on blur. A null name folds to the untitled default. Delete is never bare - it arms a
 * two-step confirm beneath the row, the tracks staying put while only the playlist and its slots go.
 */
export function PlaylistRow({
  playlist,
  onOpen,
}: {
  playlist: PlaylistRowData;
  onOpen: () => void;
}) {
  const rename = useRenamePlaylist();
  const remove = useRemovePlaylist();
  const { src: cover } = usePlaylistCover(playlist.id, "thumb");
  const t = useT();

  const [editing, setEditing] = useState(false);
  const [confirming, setConfirming] = useState(false);

  const untitled = playlist.name == null || playlist.name === "";
  const name = untitled ? t((d) => d.playlists.untitled) : (playlist.name as string);

  const onRename = (next: string) => {
    void rename(playlist.id, next === "" ? null : next);
  };

  const onConfirmDelete = async () => {
    setConfirming(false);
    await remove(playlist.id);
  };

  return (
    <div className={styles.rowWrap}>
      <div className={styles.row}>
        <div className={styles.thumb}>
          {cover ? (
            <Cover src={cover} alt="" />
          ) : (
            <span className={styles.thumbGlyph} aria-hidden="true">
              <ListMusic size={18} strokeWidth={1.8} />
            </span>
          )}
        </div>
        <div className={styles.main}>
          {editing ? (
            <EditableField
              value={playlist.name ?? ""}
              ariaLabel={t((d) => d.playlists.playlistName)}
              placeholder={t((d) => d.playlists.untitled)}
              autoFocus
              onCommit={onRename}
              onDone={() => setEditing(false)}
            />
          ) : (
            <button
              type="button"
              className={styles.name}
              data-untitled={untitled ? "" : undefined}
              onClick={onOpen}
            >
              {name}
            </button>
          )}
          <span className={styles.count}>
            {t((d) => d.playlists.trackCount, { n: playlist.track_count })}
          </span>
        </div>

        <div className={styles.controls}>
          <button
            type="button"
            className={styles.glyph}
            aria-label={t((d) => d.playlists.playlistName)}
            onClick={() => setEditing(true)}
          >
            <Pencil size={15} strokeWidth={1.8} />
          </button>
          <button
            type="button"
            className={`${styles.glyph} ${styles.remove}`}
            aria-label={t((d) => d.playlists.delete)}
            onClick={() => setConfirming(true)}
          >
            <Trash2 size={15} strokeWidth={1.8} />
          </button>
        </div>
      </div>

      {confirming ? (
        <div className={styles.confirm}>
          <span className={styles.prompt}>{t((d) => d.playlists.deleteConfirm)}</span>
          <QuietButton onClick={() => void onConfirmDelete()}>
            {t((d) => d.playlists.deleteAction)}
          </QuietButton>
          <QuietButton onClick={() => setConfirming(false)}>{t((d) => d.common.cancel)}</QuietButton>
        </div>
      ) : null}
    </div>
  );
}
