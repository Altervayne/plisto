// -- Framework Imports --
import { useRef, useState } from "react";

// -- Component Imports --
import { QuietButton } from "../common/QuietButton";

// -- Hook Imports --
import type { MountState } from "../../hooks/useMountTransition";

// -- i18n Imports --
import { useT } from "../../i18n";

// -- Style Imports --
import styles from "./AlbumSelectionBar.module.css";

/**
 * The scoped action bar over an album-track selection, shown at the head of the list only while tracks
 * are selected. It carries the count, a select-all, a move-to-disc menu, an add-to-playlist, a
 * set-cover, the two keep-own-cover toggles, a remove, and a clear. The move menu lists the album's existing discs plus
 * one entry for the next new disc; choosing a disc lays the selection there. Every action reports up -
 * the parent owns the selection, the layout, and the playlist picker.
 */
export function AlbumSelectionBar({
  count,
  discs,
  newDisc,
  state,
  onSelectAll,
  onAddToQueue,
  onMoveToDisc,
  onExtract,
  onAddToPlaylist,
  onSetCover,
  onKeepOwnCover,
  onUseAlbumCover,
  onRemove,
  onClear,
}: {
  count: number;
  discs: number[];
  newDisc: number;
  state?: MountState;
  onSelectAll: () => void;
  // Absent while the player is off, so the bar simply drops the entry.
  onAddToQueue?: () => void;
  onMoveToDisc: (disc: number) => void;
  onExtract: () => void;
  onAddToPlaylist: () => void;
  onSetCover: () => void;
  onKeepOwnCover: () => void;
  onUseAlbumCover: () => void;
  onRemove: () => void;
  onClear: () => void;
}) {
  const t = useT();
  const [menuOpen, setMenuOpen] = useState(false);

  // The count empties as the selection clears, but the parent holds the bar through its exit; keep the
  // last real tally so the fade shows it rather than a bare zero.
  const lastCount = useRef(count);
  if (count > 0) lastCount.current = count;

  const move = (disc: number) => {
    setMenuOpen(false);
    onMoveToDisc(disc);
  };

  return (
    <div className={styles.bar} data-state={state} role="toolbar" aria-label={t((d) => d.selection.actions)}>
      <span className={styles.count}>{t((d) => d.albums.selected, { n: lastCount.current })}</span>

      <div className={styles.actions}>
        <QuietButton onClick={onSelectAll}>{t((d) => d.albums.selectAll)}</QuietButton>

        {onAddToQueue ? (
          <QuietButton onClick={onAddToQueue}>{t((d) => d.player.addToQueue)}</QuietButton>
        ) : null}

        <div className={styles.moveWrap}>
          <QuietButton onClick={() => setMenuOpen((open) => !open)}>
            {t((d) => d.albums.moveToDisc)}
          </QuietButton>
          {menuOpen ? (
            <>
              <div className={styles.backdrop} onClick={() => setMenuOpen(false)} aria-hidden="true" />
              <ul className={styles.menu} role="menu" aria-label={t((d) => d.albums.moveToDisc)}>
                {discs.map((disc) => (
                  <li key={disc}>
                    <button
                      type="button"
                      className={styles.option}
                      role="menuitem"
                      onClick={() => move(disc)}
                    >
                      {t((d) => d.albums.discLabel, { n: disc })}
                    </button>
                  </li>
                ))}
                <li>
                  <button
                    type="button"
                    className={styles.option}
                    role="menuitem"
                    onClick={() => move(newDisc)}
                  >
                    {t((d) => d.albums.newDisc, { n: newDisc })}
                  </button>
                </li>
              </ul>
            </>
          ) : null}
        </div>

        <QuietButton onClick={onExtract}>{t((d) => d.extract.action)}</QuietButton>
        <QuietButton onClick={onAddToPlaylist}>{t((d) => d.playlists.addTo)}</QuietButton>
        <QuietButton onClick={onSetCover}>{t((d) => d.albums.setCover)}</QuietButton>
        <QuietButton onClick={onKeepOwnCover}>{t((d) => d.albums.keepOwnCover)}</QuietButton>
        <QuietButton onClick={onUseAlbumCover}>{t((d) => d.albums.useAlbumCover)}</QuietButton>
        <QuietButton onClick={onRemove}>{t((d) => d.albums.removeFromAlbum)}</QuietButton>
        <QuietButton onClick={onClear}>{t((d) => d.common.clear)}</QuietButton>
      </div>
    </div>
  );
}
