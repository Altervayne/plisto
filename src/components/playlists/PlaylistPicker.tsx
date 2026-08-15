// -- Framework Imports --
import { useMemo, useState } from "react";

// -- Component Imports --
import { ScrollArea } from "../common/ScrollArea/ScrollArea";
import { SearchField } from "../common/SearchField";

// -- Type Imports --
import type { PlaylistRow } from "../../types";

// -- i18n Imports --
import { useT } from "../../i18n";

// -- Style Imports --
import styles from "./PlaylistPicker.module.css";

/** The playlist's display name, folding a null name to the same untitled default the list shows. */
function playlistName(playlist: PlaylistRow, untitled: string): string {
  return playlist.name ?? untitled;
}

/**
 * A quiet floating panel to drop the selection into a playlist. A search field filters by name and
 * doubles as a create box: when the typed text names no existing playlist, a Create row spins up a new
 * one and adds to it. Choosing a row adds to that playlist. A transparent backdrop catches an outside
 * click to close. Presentational: the parent owns what a choose or a create does over its own selection.
 */
export function PlaylistPicker({
  playlists,
  onChoose,
  onCreate,
  onClose,
}: {
  playlists: PlaylistRow[];
  onChoose: (playlistId: number) => void;
  onCreate: (name: string) => void;
  onClose: () => void;
}) {
  const [filter, setFilter] = useState("");
  const t = useT();
  const untitled = t((d) => d.playlists.untitled);

  const trimmed = filter.trim();
  const qf = trimmed.toLowerCase();

  const shown = useMemo(() => {
    if (!qf) return playlists;
    return playlists.filter((p) => playlistName(p, untitled).toLowerCase().includes(qf));
  }, [playlists, qf, untitled]);

  // Offer to create only when the typed text names no existing playlist, so a mere re-type routes back
  // to the real one rather than spawning a near-duplicate.
  const showCreate =
    trimmed !== "" && !playlists.some((p) => playlistName(p, untitled).toLowerCase() === qf);

  return (
    <>
      <div className={styles.backdrop} onClick={onClose} aria-hidden="true" />
      <div className={styles.panel} role="dialog" aria-label={t((d) => d.playlists.pickerTitle)}>
        <div className={styles.search}>
          <SearchField
            value={filter}
            onChange={setFilter}
            placeholder={t((d) => d.playlists.find)}
          />
        </div>
        <ScrollArea className={styles.scroll}>
          <ul className={styles.list}>
            {shown.map((playlist) => (
              <li key={playlist.id}>
                <button
                  type="button"
                  className={styles.option}
                  onClick={() => onChoose(playlist.id)}
                >
                  <span className={styles.name}>{playlistName(playlist, untitled)}</span>
                  <span className={styles.count}>
                    {t((d) => d.playlists.trackCount, { n: playlist.track_count })}
                  </span>
                </button>
              </li>
            ))}
            {showCreate ? (
              <li>
                <button
                  type="button"
                  className={`${styles.option} ${styles.create}`}
                  onClick={() => onCreate(trimmed)}
                >
                  {t((d) => d.playlists.create, { name: trimmed })}
                </button>
              </li>
            ) : null}
            {shown.length === 0 && !showCreate ? (
              <li className={styles.empty}>{t((d) => d.playlists.pickerEmpty)}</li>
            ) : null}
          </ul>
        </ScrollArea>
      </div>
    </>
  );
}
