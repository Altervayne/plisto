// -- Framework Imports --
import { useLayoutEffect, useRef, useState } from "react";

// -- Unit Imports --
import { BOX_ORDER, boxShape } from "./boxCatalog";

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
 * The add-box picker: a floating menu listing every catalog box grouped by shape, each with its label
 * and a one-line description. A box already on the board reads disabled. It offers all types regardless
 * of mode - the mode only seeds the defaults, the user may add anything. A transparent backdrop behind
 * it catches the dismissing click.
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

  useLayoutEffect(() => {
    const panel = panelRef.current;
    if (!panel) return;
    const margin = 8;
    const overflow = panel.getBoundingClientRect().right - (window.innerWidth - margin);
    if (overflow > 0) setShift(overflow);
  }, []);

  const present = new Set(layout.map((box) => box.type));
  const stats = BOX_ORDER.filter((type) => boxShape(type) === "stat");
  const lists = BOX_ORDER.filter((type) => boxShape(type) === "list");
  const suggestions = BOX_ORDER.filter((type) => boxShape(type) === "suggestion");

  const group = (title: string, types: readonly BoxType[]) => (
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
        style={{ left: -shift }}
      >
        {group(t((d) => d.home.groupStats), stats)}
        {group(t((d) => d.home.groupLists), lists)}
        {group(t((d) => d.home.groupSuggestions), suggestions)}
      </div>
    </>
  );
}
