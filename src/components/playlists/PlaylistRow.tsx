// -- Framework Imports --
import { useState } from "react";

// -- Component Imports --
import { EditableField } from "../common/EditableField/EditableField";
import { QuietButton } from "../common/QuietButton";
import { Cover } from "../common/Cover/Cover";
import { ContextMenu, useContextMenu } from "../common/ContextMenu";

// -- Icon Imports --
import { ListEnd, ListMusic, Maximize2, Pencil, Play, Trash2 } from "lucide-react";

// -- Hook Imports --
import { usePlaylistCover } from "./usePlaylistCover";
import { usePlayPlaylist } from "./usePlayPlaylist";

// -- State Imports --
import { useRemovePlaylist, useRenamePlaylist } from "../../state/playlists/store";
import { usePlayerEnabled } from "../../state/player/store";

// -- Type Imports --
import type { MenuEntry } from "../common/ContextMenu";
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
 * The right-click menu carries the same actions, led by Play and Add to queue while the player is on.
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
  const playback = usePlayPlaylist(playlist.id);
  const playerEnabled = usePlayerEnabled();
  const menu = useContextMenu();
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

  const buildMenu = (): MenuEntry[] => {
    const items: MenuEntry[] = [];
    // Play leads only while the player is on; off, the whole scattered play surface goes quiet.
    if (playerEnabled) {
      items.push(
        {
          icon: <Play size={16} strokeWidth={1.8} />,
          label: t((d) => d.player.play),
          onSelect: playback.play,
          disabled: !playback.playable,
        },
        {
          icon: <ListEnd size={16} strokeWidth={1.8} />,
          label: t((d) => d.player.addToQueue),
          onSelect: playback.addToQueue,
          disabled: !playback.playable,
        },
      );
    }
    items.push(
      {
        icon: <Maximize2 size={16} strokeWidth={1.8} />,
        label: t((d) => d.playlists.open),
        onSelect: onOpen,
      },
      {
        icon: <Pencil size={16} strokeWidth={1.8} />,
        label: t((d) => d.playlists.rename),
        onSelect: () => setEditing(true),
      },
      { separator: true },
      {
        icon: <Trash2 size={16} strokeWidth={1.8} />,
        label: t((d) => d.playlists.delete),
        style: "destructive",
        onSelect: () => setConfirming(true),
      },
    );
    return items;
  };

  return (
    <div className={styles.rowWrap}>
      <div className={styles.row} onContextMenu={menu.onContextMenu}>
        <div className={styles.thumb}>
          {cover ? (
            <Cover src={cover} alt="" />
          ) : (
            <span className={styles.thumbGlyph} aria-hidden="true">
              <ListMusic size={18} strokeWidth={1.8} />
            </span>
          )}
          {/* The play affordance, the album tile's disc at thumb scale. Mouse-only: the menu Play is
           * the accessible route. Gone while the player is off or nothing in the playlist can play. */}
          {playerEnabled && playback.playable ? (
            <span
              className={styles.play}
              aria-hidden="true"
              onClick={(event) => {
                event.stopPropagation();
                playback.play();
              }}
            >
              <Play size={12} strokeWidth={2} fill="currentColor" />
            </span>
          ) : null}
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

      <ContextMenu
        open={menu.open}
        x={menu.x}
        y={menu.y}
        onClose={menu.close}
        items={buildMenu()}
        ariaLabel={name}
      />
    </div>
  );
}
