// -- Framework Imports --
import { useLayoutEffect, useMemo, useRef } from "react";
import type { CSSProperties, MouseEvent, RefObject } from "react";

// -- Component Imports --
import { BrowseCover } from "./BrowseCover";

// -- Hook Imports --
import { useShelfKeys } from "./useShelfKeys";

// -- Utils Imports --
import { layoutLabels, place, windowRange, zIndexOf } from "./shelfLayout";
import { groupLabelText } from "./groupLabelText";
import { recordId, recordLabel } from "./browseRecord";

// -- Type Imports --
import type { BrowseOrder } from "./browseOrder";
import type { Placement } from "./shelfLayout";

// -- i18n Imports --
import { useT } from "../../../i18n";

// -- Style Imports --
import styles from "./BrowseShelf.module.css";

/** The cover edge on the shelf, in CSS pixels. The stage publishes it as --cs for the CSS. */
export const COVER_SIZE = 236;

/** Records this close to the focus get a compositor layer; they are the ones that move most. */
const NEAR = 2;

/**
 * The shelf: a listbox over a window of records around the focus, each placed in CSS 3D by its
 * distance from the focus plus a gap per group boundary, with a floating label over each group's first
 * record. Only the window is mounted, so the DOM holds the same few records whatever the library size.
 * The focus itself lives above, as an album id; this reports moves and activations.
 */
export function BrowseShelf({
  order,
  focus,
  reduced,
  fadeSeq,
  nowYear,
  stageRef,
  onFocus,
  onActivate,
  onMenu,
}: {
  order: BrowseOrder;
  focus: number;
  reduced: boolean;
  /** Bumped on each jump; every bump replays the cut fade. */
  fadeSeq: number;
  nowYear: number;
  stageRef: RefObject<HTMLDivElement | null>;
  onFocus: (index: number, jump: boolean) => void;
  onActivate: () => void;
  onMenu?: (x: number, y: number) => void;
}) {
  const t = useT();
  const untitled = t((d) => d.albums.untitled);
  const sceneRef = useRef<HTMLDivElement | null>(null);
  const planeRef = useRef<HTMLDivElement | null>(null);
  const { items, groups, groupOf } = order;
  const count = items.length;

  const shape = useMemo(() => ({ count, groups, groupOf }), [count, groups, groupOf]);
  const onKeyDown = useShelfKeys({ stageRef, shape, focus, onFocus, onActivate, onMenu });

  const { lo, hi } = windowRange(focus, count);
  const placed: Placement[] = [];
  for (let i = lo; i <= hi; i++) placed.push(place(i, focus, groupOf, COVER_SIZE, reduced));
  const starts = groups.filter((g) => g.start >= lo && g.start <= hi).map((g) => g.start);
  const labels = layoutLabels(
    starts,
    (i) => placed[i - lo],
    focus,
    groupOf,
    COVER_SIZE,
    reduced,
  );

  // A jump cuts to its target under a short fade rather than flying through the records between.
  useLayoutEffect(() => {
    const scene = sceneRef.current;
    if (fadeSeq === 0 || reduced || !scene) return;
    scene.classList.remove(styles.fade);
    void scene.offsetWidth;
    scene.classList.add(styles.fade);
  }, [fadeSeq, reduced]);

  // A regroup or a chip re-places every record: flush the new places with transitions off, so nothing
  // slides from where it sat in the old order.
  const shownOrder = useRef(order);
  useLayoutEffect(() => {
    const plane = planeRef.current;
    if (shownOrder.current === order || !plane) return;
    shownOrder.current = order;
    plane.setAttribute("data-instant", "");
    void plane.offsetWidth;
    plane.removeAttribute("data-instant");
  }, [order]);

  const indexAt = (event: MouseEvent): number | null => {
    const record = (event.target as Element).closest<HTMLElement>("[data-index]");
    return record ? Number(record.dataset.index) : null;
  };

  // A neighbour click focuses it; the focus itself does nothing on a click.
  const onClick = (event: MouseEvent) => {
    const index = indexAt(event);
    if (index === null) return;
    stageRef.current?.focus({ preventScroll: true });
    if (index !== focus) onFocus(index, false);
  };

  // A right-click on a neighbour focuses it; on the focus it opens the record's menu.
  const onContextMenu = (event: MouseEvent) => {
    const index = indexAt(event);
    if (index === null) return;
    event.preventDefault();
    stageRef.current?.focus({ preventScroll: true });
    if (index !== focus) onFocus(index, false);
    else onMenu?.(event.clientX, event.clientY);
  };

  return (
    <div
      ref={stageRef}
      className={styles.stage}
      role="listbox"
      tabIndex={0}
      aria-label={t((d) => d.collection.browseShelf, { n: count })}
      aria-activedescendant={count > 0 ? recordId(items[focus].id) : undefined}
      data-reduced={reduced ? "" : undefined}
      style={{ "--cs": `${COVER_SIZE}px` } as CSSProperties}
      onKeyDown={onKeyDown}
    >
      <div ref={sceneRef} className={styles.scene}>
        <div
          ref={planeRef}
          className={styles.plane}
          onClick={onClick}
          onContextMenu={onContextMenu}
        >
          {placed.map((p, k) => {
            const i = lo + k;
            const album = items[i];
            return (
              <BrowseCover
                key={album.id}
                album={album}
                index={i}
                total={count}
                title={album.title ?? untitled}
                label={recordLabel(album, untitled)}
                transform={p.transform}
                veil={p.veil}
                zIndex={zIndexOf(i, focus)}
                focused={i === focus}
                near={Math.abs(i - focus) <= NEAR}
              />
            );
          })}
          {labels.map((label) => (
            <div
              key={label.start}
              className={label.current ? `${styles.label} ${styles.labelCurrent}` : styles.label}
              aria-hidden="true"
              style={{
                transform: label.transform,
                maxWidth: label.maxWidth,
                opacity: label.opacity,
              }}
            >
              {groupLabelText(groups[groupOf[label.start]].label, t, nowYear)}
            </div>
          ))}
        </div>
      </div>
    </div>
  );
}
