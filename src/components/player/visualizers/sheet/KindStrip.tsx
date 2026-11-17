// -- Framework Imports --
import { useCallback, useEffect, useLayoutEffect, useRef, useState } from "react";
import type { CSSProperties, ReactNode, RefObject } from "react";

// -- Icon Imports --
import { ChevronLeft, ChevronRight } from "lucide-react";

// -- Component Imports --
import { KindTile } from "../tiles/KindTile";

// -- Hook Imports --
import { useStripWheel } from "./useStripWheel";
import { useLoadingCue } from "../useLoadingCue";

// -- State Imports --
import { warmKind } from "../gl/warm";
import { useVisualizerPreview, useVisualizerSheet } from "../../../../state/player/visualizerSheet";
import type { VisualizerKind } from "../../../../state/player/visualizerKind";

// -- Local Imports --
import { sheetGroupLabel, type SheetGroup, type SheetGroupId } from "./sheetGroups";
import { CHEVRON_STEP, FADE_RIGHT, TILE_WIDTH, chipAt, fadeState, openScrollTarget } from "./stripMath";

// -- i18n Imports --
import { useT } from "../../../../i18n";

// -- Style Imports --
import styles from "./KindStrip.module.css";

interface KindStripProps {
  // The runs, in order. The checked kind is always in one of them.
  groups: readonly SheetGroup[];
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
export function KindStrip({ groups, checked, stripRef, onPick, onGroupChange, tagFor }: KindStripProps) {
  const t = useT();
  const [fades, setFades] = useState({ left: 0, right: FADE_RIGHT });
  const hovered = useRef<VisualizerKind | null>(null);
  useStripWheel(stripRef);
  const aimed = useVisualizerPreview() ?? checked;
  const cueing = useLoadingCue(aimed);

  const sync = useCallback(() => {
    const strip = stripRef.current;
    if (!strip) return;
    const max = strip.scrollWidth - strip.clientWidth;
    const next = fadeState(strip.scrollLeft, max);
    setFades((prev) => (prev.left === next.left && prev.right === next.right ? prev : next));
    const offsets = [...strip.querySelectorAll<HTMLElement>("[data-group]")].map((g) => g.offsetLeft);
    const current = groups[chipAt(strip.scrollLeft, offsets, max)];
    if (current) onGroupChange(current.id);
  }, [stripRef, groups, onGroupChange]);

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
          // Warming starts at once, ahead of the preview's dwell.
          if (hovered.current) warmKind(hovered.current);
          preview(hovered.current ?? focusedKind());
        }}
        onPointerLeave={() => {
          hovered.current = null;
          preview(focusedKind());
        }}
        onFocus={(e) => {
          if (!e.target.matches(":focus-visible")) return;
          const kind = kindOf(e.target);
          if (kind) warmKind(kind);
          preview(kind);
        }}
        onBlur={(e) => {
          if (!stripRef.current?.contains(e.relatedTarget as Node | null)) preview(hovered.current);
        }}
      >
        {groups.map((group) => (
          <div key={group.id} className={styles.group} data-group={group.id}>
            <span className={styles.heading} aria-hidden="true">
              {group.id === "off" ? <>&nbsp;</> : sheetGroupLabel(group.id, t)}
            </span>
            <div className={styles.row} role="radiogroup" aria-label={sheetGroupLabel(group.id, t)}>
              {group.kinds.map((kind) => (
                <KindTile
                  key={kind}
                  kind={kind}
                  checked={kind === checked}
                  width={TILE_WIDTH}
                  tabIndex={kind === checked ? 0 : -1}
                  tag={tagFor?.(kind)}
                  loading={cueing && kind === aimed}
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
