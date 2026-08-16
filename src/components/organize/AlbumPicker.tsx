// -- Framework Imports --
import { useCallback, useEffect, useMemo, useState } from "react";

// -- Component Imports --
import { ScrollArea } from "../common/ScrollArea/ScrollArea";
import { SearchField } from "../common/SearchField";

// -- Hook Imports --
import { useMountTransition } from "../../hooks/useMountTransition";

// -- Type Imports --
import type { AlbumRow } from "../../types";

// -- i18n Imports --
import { useT } from "../../i18n";

// -- Style Imports --
import styles from "./AlbumPicker.module.css";

/** The panel's exit before it unmounts, matching --dur-fast on the exit keyframe. */
const EXIT_MS = 120;

/** The album's display name, folding an unset title to the same untitled label the cards show. */
function albumName(album: AlbumRow, untitled: string): string {
  return album.title ?? untitled;
}

/**
 * A quiet floating panel that lists existing albums to drop the selection into. A search field filters
 * by title; choosing a row reports the album up. A transparent backdrop catches an outside click to
 * close. With no albums yet it points back at Create rather than showing an empty list.
 */
export function AlbumPicker({
  albums,
  onChoose,
  onClose,
}: {
  albums: AlbumRow[];
  onChoose: (albumId: number) => void;
  onClose: () => void;
}) {
  const [filter, setFilter] = useState("");
  const t = useT();
  const untitled = t((d) => d.albums.untitled);

  // A backdrop dismiss plays the exit before the parent drops the panel; choosing a row closes at once
  // through the parent, which unmounts it with the selection.
  const [open, setOpen] = useState(true);
  const panel = useMountTransition(open, EXIT_MS);
  const requestClose = useCallback(() => setOpen(false), []);
  useEffect(() => {
    if (!panel.mounted) onClose();
  }, [panel.mounted, onClose]);

  const shown = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return albums;
    return albums.filter((a) => albumName(a, untitled).toLowerCase().includes(q));
  }, [albums, filter, untitled]);

  if (!panel.mounted) return null;

  return (
    <>
      <div className={styles.backdrop} onClick={requestClose} aria-hidden="true" />
      <div className={styles.panel} data-state={panel.state} role="dialog" aria-label={t((d) => d.selection.pickerTitle)}>
        {albums.length === 0 ? (
          <p className={styles.empty}>{t((d) => d.selection.noAlbums)}</p>
        ) : (
          <>
            <div className={styles.search}>
              <SearchField
                value={filter}
                onChange={setFilter}
                placeholder={t((d) => d.selection.findAlbum)}
              />
            </div>
            <ScrollArea className={styles.scroll}>
              <ul className={styles.list}>
                {shown.map((album) => (
                  <li key={album.id}>
                    <button
                      type="button"
                      className={styles.option}
                      onClick={() => onChoose(album.id)}
                    >
                      <span className={styles.name}>{albumName(album, untitled)}</span>
                      <span className={styles.count}>
                        {t((d) => d.albums.trackCount, { n: album.track_count })}
                      </span>
                    </button>
                  </li>
                ))}
                {shown.length === 0 ? (
                  <li className={styles.noMatch}>
                    {t((d) => d.selection.noAlbumMatch, { q: filter.trim() })}
                  </li>
                ) : null}
              </ul>
            </ScrollArea>
          </>
        )}
      </div>
    </>
  );
}
