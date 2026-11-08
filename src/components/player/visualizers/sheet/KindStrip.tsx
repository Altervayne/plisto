// -- Framework Imports --
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { CSSProperties, ReactNode, RefObject } from "react";

// -- Icon Imports --
import { ChevronLeft, ChevronRight } from "lucide-react";

// -- Component Imports --
import { KindTile } from "../tiles/KindTile";

// -- Hook Imports --
import { useStripWheel } from "./useStripWheel";

// -- State Imports --
import { useVisualizerSheet } from "../../../../state/player/visualizerSheet";
import type { VisualizerKind } from "../../../../state/player/visualizerKind";

// -- Local Imports --
import { SHEET_GROUPS, SHEET_GROUP_LABELS, type SheetGroupId } from "./sheetGroups";
import { CHEVRON_STEP, FADE_RIGHT, TILE_WIDTH, chipAt, fadeState, openScrollTarget } from "./stripMath";

// -- i18n Imports --
import { useT } from "../../../../i18n";

// -- Style Imports --
import styles from "./KindStrip.module.css";

interface KindStripProps {
  checked: VisualizerKind;
  // The scroller, shared with the group chips that jump along it.
  stripRef: RefObject<HTMLDivElement | null>;
  onPick: (kind: VisualizerKind) => void;
  onGroupChange: (id: SheetGroupId) => void;
  // A `KindTag` over a kind's thumb, if any.
  tagFor?: (kind: VisualizerKind) => ReactNode;
}

const reducedMotion = () => window.matchMedia("(prefers-reduced-motion: reduce)").matches;

function kindOf(target: EventTarget | null): VisualizerKind | null {
  if (!(target instanceof Element)) return null;
  const tile = target.closest<HTMLElement>("[data-kind]");
  return (tile?.dataset.kind as VisualizerKind | undefined) ?? null;
}

/**
 * Every kind in one horizontal filmstrip under its group headings, Off last. Only the checked tile is a
 * tab stop. The edge fades and the chevrons show only where more tiles lie beyond, and they follow the
 * scroll. Hover and keyboard focus preview a tile on the stage through the sheet store, delegated here
 * rather than bound per tile. The strip opens on the checked tile once, on mount; a later pick leaves the
 * scroll where it is.
 */
export function KindStrip({ checked, stripRef, onPick, onGroupChange, tagFor }: KindStripProps) {
  const t = useT();
  const [fades, setFades] = useState({ left: 0, right: FADE_RIGHT });
  const hovered = useRef<VisualizerKind | null>(null);
  useStripWheel(stripRef);

  const sync = useCallback(() => {
    const strip = stripRef.current;
    if (!strip) return;
    const max = strip.scrollWidth - strip.clientWidth;
    const next = fadeState(strip.scrollLeft, max);
    setFades((prev) => (prev.left === next.left && prev.right === next.right ? prev : next));
    const offsets = [...strip.querySelectorAll<HTMLElement>("[data-group]")].map((g) => g.offsetLeft);
    onGroupChange(SHEET_GROUPS[chipAt(strip.scrollLeft, offsets, max)].id);
  }, [stripRef, onGroupChange]);

  useLayoutEffect(() => {
    const strip = stripRef.current;
    const tile = strip?.querySelector<HTMLElement>('[aria-checked="true"]');
    const group = tile?.closest<HTMLElement>("[data-group]");
    if (!strip || !tile || !group) return;
    strip.scrollLeft = openScrollTarget({
      tileLeft: tile.offsetLeft,
      groupLeft: group.offsetLeft,
      groupWidth: group.offsetWidth,
      viewport: strip.clientWidth,
      max: strip.scrollWidth - strip.clientWidth,
    });
    sync();
    // Mount only: a later pick keeps the scroll.
  }, []);

  // A resize moves the far end, so the fades and the chevrons are measured again.
  useEffect(() => {
    const strip = stripRef.current;
    if (!strip) return;
    const observer = new ResizeObserver(sync);
    observer.observe(strip);
    return () => observer.disconnect();
  }, [stripRef, sync]);

  const scrollBy = (dir: 1 | -1) =>
    stripRef.current?.scrollBy({ left: dir * CHEVRON_STEP, behavior: reducedMotion() ? "auto" : "smooth" });

  // The tile holding keyboard focus, which a preview falls back to when the pointer leaves.
  const focusedKind = () => {
    const el = document.activeElement;
    return el instanceof HTMLElement && stripRef.current?.contains(el) && el.matches(":focus-visible")
      ? kindOf(el)
      : null;
  };
  const { preview } = useVisualizerSheet.getState();

  const chevron = (dir: 1 | -1) => (
    <button
      type="button"
      tabIndex={-1}
      aria-hidden="true"
      className={`${styles.chevron} ${dir < 0 ? styles.left : styles.right}`}
      data-gone={(dir < 0 ? fades.left : fades.right) === 0 ? "" : undefined}
      // Keeps focus where it was, so a chevron press never pulls it off a tile.
      onMouseDown={(e) => e.preventDefault()}
      onClick={() => scrollBy(dir)}
    >
      {dir < 0 ? <ChevronLeft size={15} strokeWidth={1.8} /> : <ChevronRight size={15} strokeWidth={1.8} />}
    </button>
  );

  return (
    <div className={styles.wrap}>
      {chevron(-1)}
      <div
        ref={stripRef}
        className={styles.strip}
        style={{ "--fl": `${fades.left}px`, "--fr": `${fades.right}px` } as CSSProperties}
        onScroll={sync}
        onPointerOver={(e) => {
          hovered.current = kindOf(e.target);
          preview(hovered.current ?? focusedKind());
        }}
        onPointerLeave={() => {
          hovered.current = null;
          preview(focusedKind());
        }}
        onFocus={(e) => {
          if (e.target.matches(":focus-visible")) preview(kindOf(e.target));
        }}
        onBlur={(e) => {
          if (!stripRef.current?.contains(e.relatedTarget as Node | null)) preview(hovered.current);
        }}
      >
        {SHEET_GROUPS.map((group) => (
          <div key={group.id} className={styles.group} data-group={group.id}>
            <span className={styles.heading} aria-hidden="true">
              {group.id === "off" ? <>&nbsp;</> : t(SHEET_GROUP_LABELS[group.id])}
            </span>
            <div className={styles.row} role="radiogroup" aria-label={t(SHEET_GROUP_LABELS[group.id])}>
              {group.kinds.map((kind) => (
                <KindTile
                  key={kind}
                  kind={kind}
                  checked={kind === checked}
                  width={TILE_WIDTH}
                  tabIndex={kind === checked ? 0 : -1}
                  tag={tagFor?.(kind)}
                  onClick={() => onPick(kind)}
                />
              ))}
            </div>
          </div>
        ))}
      </div>
      {chevron(1)}
    </div>
  );
}
