// -- Framework Imports --
import { useLayoutEffect, useRef, useState } from "react";

// -- Component Imports --
import { ScrollArea } from "../common/ScrollArea/ScrollArea";

// -- Unit Imports --
import { BOX_ORDER, boxInMode, boxShape } from "./boxCatalog";

// -- State Imports --
import { useAppMode } from "../../state/player/store";

// -- Type Imports --
import type { BoxSeed, BoxType } from "./boxCatalog";
import type { Dict } from "../../i18n/en";

// -- i18n Imports --
import { useT } from "../../i18n";

// -- Style Imports --
import styles from "./BoxPicker.module.css";

/** Each type's picker label. Two unsorted boxes share the wall label; their descriptions tell them apart. */
export const BOX_LABEL: Record<BoxType, (d: Dict) => string> = {
  missingCovers: (d) => d.home.missingCoversLabel,
  unsortedStat: (d) => d.home.unsortedLabel,
  unsortedPreview: (d) => d.home.unsortedLabel,
  recentlyPlayed: (d) => d.home.recentlyPlayedLabel,
  mostPlayed: (d) => d.home.mostPlayedLabel,
  missingMetadata: (d) => d.home.missingMetaLabel,
  playNext: (d) => d.home.playNextLabel,
  moreFromArtist: (d) => d.home.moreFromArtistLabel,
};

/** Each type's one-line picker description. */
const DESC: Record<BoxType, (d: Dict) => string> = {
  missingCovers: (d) => d.home.boxDesc.missingCovers,
  unsortedStat: (d) => d.home.boxDesc.unsortedStat,
  unsortedPreview: (d) => d.home.boxDesc.unsortedPreview,
  recentlyPlayed: (d) => d.home.boxDesc.recentlyPlayed,
  mostPlayed: (d) => d.home.boxDesc.mostPlayed,
  missingMetadata: (d) => d.home.boxDesc.missingMetadata,
  playNext: (d) => d.home.boxDesc.playNext,
  moreFromArtist: (d) => d.home.boxDesc.moreFromArtist,
};

/**
 * The add-box picker: a floating menu listing the current mode's catalog boxes grouped by shape, each
 * with its label and a one-line description. A box already on the board reads disabled. Only boxes the
 * mode carries are offered - a box routes to a destination its mode may hide, so an off-mode box would
 * add a dead end. A group with no box in the mode drops out. A transparent backdrop behind it catches
 * the dismissing click.
 */
export function BoxPicker({
  layout,
  onPick,
  onClose,
}: {
  layout: BoxSeed[];
  onPick: (type: BoxType) => void;
  onClose: () => void;
}) {
  const t = useT();
  const panelRef = useRef<HTMLDivElement | null>(null);
  // Shift the panel left when its right edge would spill past the viewport, so an add tile near the
  // right edge opens the menu back onto the screen instead of forcing a horizontal scroll.
  const [shift, setShift] = useState(0);
  // Open the panel upward when dropping down would spill past the viewport foot, so an add tile low on
  // the page keeps the whole menu on-screen instead of growing the page and its scrollbar.
  const [flipUp, setFlipUp] = useState(false);

  useLayoutEffect(() => {
    const panel = panelRef.current;
    if (!panel) return;
    const margin = 8;
    const rect = panel.getBoundingClientRect();
    const overflow = rect.right - (window.innerWidth - margin);
    if (overflow > 0) setShift(overflow);
    if (rect.bottom > window.innerHeight - margin) setFlipUp(true);
  }, []);

  const appMode = useAppMode();
  const present = new Set(layout.map((box) => box.type));
  // Only the current mode's boxes, so the picker never offers one that routes to a hidden destination.
  const inMode = (type: BoxType) => boxInMode(type, appMode);
  const stats = BOX_ORDER.filter((type) => boxShape(type) === "stat" && inMode(type));
  const lists = BOX_ORDER.filter((type) => boxShape(type) === "list" && inMode(type));
  const suggestions = BOX_ORDER.filter((type) => boxShape(type) === "suggestion" && inMode(type));

  const group = (title: string, types: readonly BoxType[]) =>
    types.length === 0 ? null : (
    <div className={styles.group}>
      <span className={styles.groupLabel}>{title}</span>
      {types.map((type) => {
        const added = present.has(type);
        return (
          <button
            key={type}
            type="button"
            className={styles.option}
            disabled={added}
            onClick={() => {
              onPick(type);
              onClose();
            }}
          >
            <span className={styles.optionName}>{t(BOX_LABEL[type])}</span>
            <span className={styles.optionDesc}>{t(DESC[type])}</span>
            {added ? <span className={styles.added}>{t((d) => d.home.added)}</span> : null}
          </button>
        );
      })}
    </div>
  );

  return (
    <>
      <div className={styles.backdrop} onClick={onClose} aria-hidden="true" />
      <div
        ref={panelRef}
        className={styles.panel}
        role="menu"
        style={flipUp ? { left: -shift, top: "auto", bottom: "calc(100% + 8px)" } : { left: -shift }}
      >
        <ScrollArea className={styles.scroll} contentClassName={styles.scrollBody}>
          {group(t((d) => d.home.groupStats), stats)}
          {group(t((d) => d.home.groupLists), lists)}
          {group(t((d) => d.home.groupSuggestions), suggestions)}
        </ScrollArea>
      </div>
    </>
  );
}
