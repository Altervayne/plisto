// -- Framework Imports --
import { useState } from "react";

// -- Component Imports --
import { QuietButton } from "../common/QuietButton";

// -- i18n Imports --
import { useT } from "../../i18n";

// -- Style Imports --
import styles from "./AlbumSelectionBar.module.css";

/**
 * The scoped action bar over an album-track selection, shown at the head of the list only while tracks
 * are selected. It carries the count, a select-all, a move-to-disc menu, an add-to-playlist, a remove,
 * and a clear. The move menu lists the album's existing discs plus one entry for the next new disc;
 * choosing a disc lays the selection there. Every action reports up - the parent owns the selection,
 * the layout, and the playlist picker.
 */
export function AlbumSelectionBar({
  count,
  discs,
  newDisc,
  onSelectAll,
  onMoveToDisc,
  onExtract,
  onAddToPlaylist,
  onRemove,
  onClear,
}: {
  count: number;
  discs: number[];
  newDisc: number;
  onSelectAll: () => void;
  onMoveToDisc: (disc: number) => void;
  onExtract: () => void;
  onAddToPlaylist: () => void;
  onRemove: () => void;
  onClear: () => void;
}) {
  const t = useT();
  const [menuOpen, setMenuOpen] = useState(false);

  const move = (disc: number) => {
    setMenuOpen(false);
    onMoveToDisc(disc);
  };

  return (
    <div className={styles.bar} role="toolbar" aria-label={t((d) => d.selection.actions)}>
      <span className={styles.count}>{t((d) => d.albums.selected, { n: count })}</span>

      <div className={styles.actions}>
        <QuietButton onClick={onSelectAll}>{t((d) => d.albums.selectAll)}</QuietButton>

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
        <QuietButton onClick={onRemove}>{t((d) => d.albums.removeFromAlbum)}</QuietButton>
        <QuietButton onClick={onClear}>{t((d) => d.common.clear)}</QuietButton>
      </div>
    </div>
  );
}
