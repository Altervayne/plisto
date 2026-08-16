// -- Framework Imports --
import { useEffect, useState } from "react";
import { createPortal } from "react-dom";

// -- Component Imports --
import { Cover } from "../common/Cover/Cover";
import { ScrollArea } from "../common/ScrollArea/ScrollArea";

// -- Hook Imports --
import { useImageThumb } from "../covers/useImageThumb";

// -- IPC Imports --
import { listFolderImages } from "../../lib/ipc";

// -- i18n Imports --
import { useT } from "../../i18n";

// -- Style Imports --
import styles from "./FolderImagePicker.module.css";

/** The trailing filename of a path, split on either separator so it reads on every platform. */
function fileName(path: string): string {
  const parts = path.split(/[\\/]/);
  return parts[parts.length - 1] || path;
}

/**
 * A scrim modal listing every loose image in the track's own folder, an extra way to set its cover
 * beside the disk Replace. Portalled over a dim scrim like the match preview; a grid of thumbnail
 * tiles, each with its basename in mono, picking one binds it and closes. Escape and a backdrop
 * click both dismiss. Presentational: the parent owns what a pick does over the track.
 */
export function FolderImagePicker({
  trackId,
  onPick,
  onClose,
}: {
  trackId: number;
  onPick: (path: string) => void;
  onClose: () => void;
}) {
  const t = useT();
  // null while the folder is still being read, so the reading state and the empty state read apart.
  const [paths, setPaths] = useState<string[] | null>(null);

  useEffect(() => {
    let live = true;
    void listFolderImages(trackId)
      .then((list) => {
        if (live) setPaths(list);
      })
      .catch(() => {
        if (live) setPaths([]);
      });
    return () => {
      live = false;
    };
  }, [trackId]);

  // Escape dismisses, matching the backdrop click.
  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [onClose]);

  return createPortal(
    // A portal bubbles through the React tree, so seal a click inside from reaching the peek's own handlers.
    <div className={styles.overlay} onClick={(event) => event.stopPropagation()}>
      <div className={styles.backdrop} onClick={onClose} aria-hidden="true" />
      <div
        className={styles.dialog}
        role="dialog"
        aria-modal="true"
        aria-label={t((d) => d.cover.folderPickTitle)}
      >
        <h2 className={styles.heading}>{t((d) => d.cover.folderPickTitle)}</h2>

        {paths === null ? (
          <p className={styles.note}>{t((d) => d.cover.folderPickReading)}</p>
        ) : paths.length === 0 ? (
          <p className={styles.note}>{t((d) => d.cover.folderPickEmpty)}</p>
        ) : (
          <ScrollArea className={styles.scroll}>
            <ul className={styles.grid}>
              {paths.map((path) => (
                <FolderImageTile
                  key={path}
                  path={path}
                  onPick={() => {
                    onPick(path);
                    onClose();
                  }}
                />
              ))}
            </ul>
          </ScrollArea>
        )}
      </div>
    </div>,
    document.body,
  );
}

/** One folder image: a lazy thumbnail tile over its basename in mono; a failed thumb is inert. */
function FolderImageTile({ path, onPick }: { path: string; onPick: () => void }) {
  const { src, failed, onError } = useImageThumb(path);
  return (
    <li className={styles.tile}>
      <button
        type="button"
        className={styles.hit}
        onClick={onPick}
        disabled={failed}
        aria-label={fileName(path)}
      >
        <Cover src={failed ? null : src} interactive alt="" onError={onError} />
      </button>
      <span className={styles.name}>{fileName(path)}</span>
    </li>
  );
}
