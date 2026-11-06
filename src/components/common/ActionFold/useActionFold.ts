// -- Framework Imports --
import { useLayoutEffect, useRef, useState } from "react";

// -- Utils Imports --
import { foldActions } from "./foldActions";

// -- Type Imports --
import type { FoldItem, FoldResult } from "./foldActions";

const NONE: FoldResult = { folded: [], separated: new Set() };

/** An element's width with its horizontal margins, fractional so a rounding step never overfills the row. */
function outerWidth(el: Element): number {
  const style = getComputedStyle(el);
  return (
    el.getBoundingClientRect().width +
    (parseFloat(style.marginLeft) || 0) +
    (parseFloat(style.marginRight) || 0)
  );
}

function sameFold(a: FoldResult, b: FoldResult): boolean {
  return (
    a.folded.length === b.folded.length &&
    a.folded.every((id, index) => id === b.folded[index]) &&
    a.separated.size === b.separated.size &&
    [...a.separated].every((id) => b.separated.has(id))
  );
}

/** The element a bar is bounded by: its offset parent when floating, its parent when in flow. */
function limitOf(bar: HTMLElement): Element | null {
  return getComputedStyle(bar).position === "absolute" ? bar.offsetParent : bar.parentElement;
}

/**
 * Measures a bar's action row and returns which actions fold into More. The row holds a hidden ghost copy
 * of every action, so natural widths are known whatever is folded. The width the row may use is the width
 * of the bounding element, less `inset` and the bar's other children. It re-measures after every render,
 * so a label that changes width re-folds, and on a ResizeObserver tick of the bounding element. The layout
 * effect settles before paint, so nothing flickers.
 */
export function useActionFold(
  actions: Array<{ id: string; keep: number; group: number }>,
  separators: boolean,
  inset: number,
) {
  const rowRef = useRef<HTMLDivElement | null>(null);
  const ghostRef = useRef<HTMLDivElement | null>(null);
  const [fold, setFold] = useState<FoldResult>(NONE);
  const latest = useRef({ actions, separators, inset });
  latest.current = { actions, separators, inset };

  const measure = useRef(() => {});
  measure.current = () => {
    const row = rowRef.current;
    const ghost = ghostRef.current;
    const bar = row?.parentElement;
    if (!row || !ghost || !bar) return;
    const limit = limitOf(bar);
    if (!limit) return;

    const { actions: current, separators: withSeparators, inset: margin } = latest.current;
    const widthOf = (selector: string) => {
      const el = ghost.querySelector(selector);
      return el ? outerWidth(el) : 0;
    };
    const items: FoldItem[] = current.map((action) => ({
      id: action.id,
      width: widthOf(`[data-fold-id="${action.id}"]`),
      keep: action.keep,
      group: action.group,
    }));

    const barStyle = getComputedStyle(bar);
    const others = Array.from(bar.children).filter((child) => child !== row);
    const chrome =
      (parseFloat(barStyle.paddingLeft) || 0) +
      (parseFloat(barStyle.paddingRight) || 0) +
      others.reduce((sum, child) => sum + outerWidth(child), 0) +
      (parseFloat(barStyle.columnGap) || 0) * others.length;

    const next = foldActions({
      items,
      available: limit.clientWidth - margin - chrome,
      gap: parseFloat(getComputedStyle(row).columnGap) || 0,
      sepWidth: withSeparators ? widthOf("[data-fold-sep]") : 0,
      moreWidth: widthOf("[data-fold-more]"),
      trailingWidth: widthOf("[data-fold-trailing]"),
    });
    setFold((prev) => (sameFold(prev, next) ? prev : next));
  };

  useLayoutEffect(() => {
    measure.current();
  });

  useLayoutEffect(() => {
    const bar = rowRef.current?.parentElement;
    const limit = bar ? limitOf(bar) : null;
    if (!limit) return;
    const observer = new ResizeObserver(() => measure.current());
    observer.observe(limit);
    return () => observer.disconnect();
  }, []);

  return { rowRef, ghostRef, fold };
}
