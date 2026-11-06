// -- Framework Imports --
import { useMemo } from "react";

// -- Component Imports --
import { ScrollArea } from "../common/ScrollArea/ScrollArea";
import { FolderEntry } from "./FolderEntry";
import { Resizer } from "../common/Resizer/Resizer";

// -- Utils Imports --
import { allSelected } from "./selectContents";
import type { GatherMode } from "./selectContents";

// -- State Imports --
import { useSelection } from "../../state/organize/store";

// -- Type Imports --
import type { FolderContents, FolderNode } from "../../state/files/folderTree";
import type { ResizerControl } from "../common/Resizer/resizerTypes";

// -- Style Imports --
import styles from "./FolderBand.module.css";

/**
 * The subfolder list above the track grid: quiet rows on the continuous surface. It caps its height
 * at the user-set band height and scrolls its own overflow, so a folder-heavy scope never shoves the
 * grid off screen. The handle on its bottom edge steers that cap. `contents` carries each folder's
 * gatherable ids; the band reads the selection once to mark the rows it fully covers.
 */
export function FolderBand({
  folders,
  contents,
  onOpen,
  onGather,
  resizer,
}: {
  folders: FolderNode[];
  contents: Map<string, FolderContents>;
  onOpen: (id: string) => void;
  onGather: (ids: number[], mode: GatherMode) => void;
  resizer: ResizerControl;
}) {
  const selection = useSelection();
  const none = useMemo<FolderContents>(() => ({ all: [], own: [] }), []);

  return (
    <div className={styles.band}>
      <ScrollArea className={styles.scroll} contentClassName={styles.list}>
        {folders.map((folder) => {
          const own = contents.get(folder.id) ?? none;
          return (
            <FolderEntry
              key={folder.id}
              folder={folder}
              contents={own}
              inSelection={allSelected(own.all, selection)}
              onOpen={onOpen}
              onGather={onGather}
            />
          );
        })}
      </ScrollArea>
      <Resizer resizer={resizer} orientation="horizontal" />
    </div>
  );
}
