// -- Framework Imports --
import type { KeyboardEvent, MouseEvent } from "react";

// -- Component Imports --
import { ContextMenu, useContextMenu } from "../common/ContextMenu";
import { Tooltip } from "../common/Tooltip/Tooltip";

// -- Icon Imports --
import { Check, CheckCheck, Folder, FolderCheck, Maximize2 } from "lucide-react";

// -- Utils Imports --
import { formatCount } from "../../lib/format";
import { gatherMode } from "./selectContents";
import type { GatherMode } from "./selectContents";

// -- Type Imports --
import type { FolderContents, FolderNode } from "../../state/files/folderTree";
import type { MenuEntry } from "../common/ContextMenu";

// -- i18n Imports --
import { useT } from "../../i18n";

// -- Style Imports --
import styles from "./FolderBand.module.css";

/**
 * One folder as a quiet row, never a tile: a folder glyph, the real-case name, and a trailing count
 * summary. No card chrome - covers are the only objects that carry shadow. The row is a container, so
 * it can hold the "Select contents" button revealed on hover or focus: clicking the row (or Enter/Space)
 * drills in, the button gathers every track beneath without opening. An empty folder keeps the button
 * inert behind a tooltip. The right-click menu adds the folder-only gather. `inSelection` marks a
 * folder whose every track is already selected.
 */
export function FolderEntry({
  folder,
  contents,
  inSelection,
  onOpen,
  onGather,
}: {
  folder: FolderNode;
  contents: FolderContents;
  inSelection: boolean;
  onOpen: (id: string) => void;
  onGather: (ids: number[], mode: GatherMode) => void;
}) {
  const t = useT();
  const menu = useContextMenu();
  const empty = contents.all.length === 0;

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    // Keys on the inner button belong to it; only the row's own focus opens the folder.
    if (event.target !== event.currentTarget) return;
    if (event.key === "Enter" || event.key === " ") {
      event.preventDefault();
      onOpen(folder.id);
    }
  };

  const onSelectContents = (event: MouseEvent<HTMLButtonElement>) => {
    event.stopPropagation();
    if (!empty) onGather(contents.all, gatherMode(event));
  };

  const menuItems: MenuEntry[] = [
    {
      icon: <Maximize2 size={16} strokeWidth={1.8} />,
      label: t((d) => d.files.open),
      onSelect: () => onOpen(folder.id),
    },
    {
      icon: <CheckCheck size={16} strokeWidth={1.8} />,
      label: `${t((d) => d.files.selectContents)} (${formatCount(contents.all.length)})`,
      disabled: empty,
      onSelect: () => onGather(contents.all, "replace"),
    },
    {
      icon: <FolderCheck size={16} strokeWidth={1.8} />,
      label: `${t((d) => d.files.selectFolderOnly)} (${formatCount(contents.own.length)})`,
      disabled: contents.own.length === 0,
      onSelect: () => onGather(contents.own, "replace"),
    },
  ];

  const selectButton = (
    <button
      type="button"
      className={styles.selectContents}
      aria-disabled={empty || undefined}
      onClick={onSelectContents}
    >
      <CheckCheck size={14} strokeWidth={1.8} />
      {t((d) => d.files.selectContents)}
    </button>
  );

  return (
    <>
      <div
        role="button"
        tabIndex={0}
        className={`${styles.entry} ${inSelection ? styles.inSelection : ""}`}
        onClick={() => onOpen(folder.id)}
        onKeyDown={onKeyDown}
        onContextMenu={menu.onContextMenu}
      >
        <span className={styles.glyph}>
          <Folder size={17} strokeWidth={1.7} />
        </span>
        <span className={styles.name}>{folder.name}</span>
        {inSelection ? (
          <span className={styles.mark}>
            <Check size={13} strokeWidth={2.2} />
            {t((d) => d.files.inSelection)}
          </span>
        ) : null}
        {empty ? (
          <Tooltip label={t((d) => d.files.emptyFolderTip)}>{selectButton}</Tooltip>
        ) : (
          selectButton
        )}
        <span className={styles.count}>
          <span>{t((d) => d.files.folderTracks, { n: folder.trackCount })}</span>
          {folder.subfolderCount > 0 ? (
            <span className={styles.more}>
              {t((d) => d.files.folderSubfolders, { n: folder.subfolderCount })}
            </span>
          ) : null}
        </span>
      </div>
      <ContextMenu
        open={menu.open}
        x={menu.x}
        y={menu.y}
        onClose={menu.close}
        items={menuItems}
        ariaLabel={folder.name}
      />
    </>
  );
}
