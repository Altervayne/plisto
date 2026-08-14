// -- Utils Imports --
import { formatCount } from "../../lib/format";

// -- Type Imports --
import type { FolderNode } from "../../state/files/folderTree";

// -- Style Imports --
import styles from "./FolderBand.module.css";

/** A folder outline in the current ink. */
function FolderIcon() {
  return (
    <svg
      width="17"
      height="17"
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.7"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      <path d="M3 7a2 2 0 0 1 2-2h4l2 2.5h8a2 2 0 0 1 2 2V17a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2Z" />
    </svg>
  );
}

/** The track-count phrase, singular-aware. */
function tracksLabel(n: number): string {
  return `${formatCount(n)} ${n === 1 ? "track" : "tracks"}`;
}

/** The subfolder-count phrase, singular-aware. */
function foldersLabel(n: number): string {
  return `${formatCount(n)} ${n === 1 ? "folder" : "folders"}`;
}

/**
 * One folder as a quiet row, never a tile: a folder glyph, the real-case name, and a trailing count
 * summary. No card chrome - covers are the only objects that carry shadow. Clicking drills into it.
 */
export function FolderEntry({
  folder,
  onOpen,
}: {
  folder: FolderNode;
  onOpen: (id: string) => void;
}) {
  return (
    <button type="button" className={styles.entry} onClick={() => onOpen(folder.id)}>
      <span className={styles.glyph}>
        <FolderIcon />
      </span>
      <span className={styles.name}>{folder.name}</span>
      <span className={styles.count}>
        <span>{tracksLabel(folder.trackCount)}</span>
        {folder.subfolderCount > 0 ? (
          <span className={styles.more}>{foldersLabel(folder.subfolderCount)}</span>
        ) : null}
      </span>
    </button>
  );
}
