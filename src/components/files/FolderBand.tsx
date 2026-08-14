// -- Component Imports --
import { ScrollArea } from "../common/ScrollArea/ScrollArea";
import { FolderEntry } from "./FolderEntry";
import { Resizer } from "../common/Resizer/Resizer";

// -- Type Imports --
import type { FolderNode } from "../../state/files/folderTree";
import type { ResizerControl } from "../common/Resizer/resizerTypes";

// -- Style Imports --
import styles from "./FolderBand.module.css";

/**
 * The subfolder list above the track grid: quiet rows on the continuous surface. It caps its height
 * at the user-set band height and scrolls its own overflow, so a folder-heavy scope never shoves the
 * grid off screen. The handle on its bottom edge steers that cap.
 */
export function FolderBand({
  folders,
  onOpen,
  resizer,
}: {
  folders: FolderNode[];
  onOpen: (id: string) => void;
  resizer: ResizerControl;
}) {
  return (
    <div className={styles.band}>
      <ScrollArea className={styles.scroll} contentClassName={styles.list}>
        {folders.map((folder) => (
          <FolderEntry key={folder.id} folder={folder} onOpen={onOpen} />
        ))}
      </ScrollArea>
      <Resizer resizer={resizer} orientation="horizontal" />
    </div>
  );
}
