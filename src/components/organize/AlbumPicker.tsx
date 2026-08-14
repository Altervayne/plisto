// -- Framework Imports --
import { useMemo, useState } from "react";

// -- Component Imports --
import { ScrollArea } from "../common/ScrollArea/ScrollArea";
import { SearchField } from "../common/SearchField";

// -- Type Imports --
import type { AlbumRow } from "../../types";

// -- Style Imports --
import styles from "./AlbumPicker.module.css";

/** The album's display name, folding an unset title to the same "Untitled" the cards show. */
function albumName(album: AlbumRow): string {
  return album.title ?? "Untitled";
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

  const shown = useMemo(() => {
    const q = filter.trim().toLowerCase();
    if (!q) return albums;
    return albums.filter((a) => albumName(a).toLowerCase().includes(q));
  }, [albums, filter]);

  return (
    <>
      <div className={styles.backdrop} onClick={onClose} aria-hidden="true" />
      <div className={styles.panel} role="dialog" aria-label="Add to album">
        {albums.length === 0 ? (
          <p className={styles.empty}>No albums yet - Create one.</p>
        ) : (
          <>
            <div className={styles.search}>
              <SearchField value={filter} onChange={setFilter} placeholder="Find album" />
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
                      <span className={styles.name}>{albumName(album)}</span>
                      <span className={styles.count}>
                        {album.track_count} {album.track_count === 1 ? "track" : "tracks"}
                      </span>
                    </button>
                  </li>
                ))}
                {shown.length === 0 ? (
                  <li className={styles.noMatch}>No album matches "{filter.trim()}"</li>
                ) : null}
              </ul>
            </ScrollArea>
          </>
        )}
      </div>
    </>
  );
}
