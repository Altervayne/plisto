// -- Type Imports --
import type { FolderNode } from "../../state/files/folderTree";

// -- Icon Imports --
import { Folder } from "lucide-react";

// -- i18n Imports --
import { useT } from "../../i18n";

// -- Style Imports --
import styles from "./FolderBand.module.css";

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
  const t = useT();

  return (
    <button type="button" className={styles.entry} onClick={() => onOpen(folder.id)}>
      <span className={styles.glyph}>
        <Folder size={17} strokeWidth={1.7} />
      </span>
      <span className={styles.name}>{folder.name}</span>
      <span className={styles.count}>
        <span>{t((d) => d.files.folderTracks, { n: folder.trackCount })}</span>
        {folder.subfolderCount > 0 ? (
          <span className={styles.more}>
            {t((d) => d.files.folderSubfolders, { n: folder.subfolderCount })}
          </span>
        ) : null}
      </span>
    </button>
  );
}
