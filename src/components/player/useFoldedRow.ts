// -- Framework Imports --
import { useLayoutEffect, useRef, useState } from "react";

// -- Type Imports --
import type { RefObject } from "react";

/** The controls width at or below which the transport row folds to two lines (matches the container query). */
export const FOLD_MAX_WIDTH = 349;

export type TransportSlot = "sound" | "cluster" | "volume";

/** Whether a controls box of this content width is folded. */
export const isFolded = (width: number): boolean => width <= FOLD_MAX_WIDTH;

/** The slots in DOM order: tab order follows the lines as drawn, so a folded row leads with the cluster. */
export const transportOrder = (folded: boolean): readonly TransportSlot[] =>
  folded ? ["cluster", "sound", "volume"] : ["sound", "cluster", "volume"];

/** A ref for the controls box and whether that box is folded, from its own content width. */
export function useFoldedRow(): [RefObject<HTMLDivElement | null>, boolean] {
  const ref = useRef<HTMLDivElement | null>(null);
  const [folded, setFolded] = useState(false);

  useLayoutEffect(() => {
    const el = ref.current;
    if (!el || typeof ResizeObserver === "undefined") return;
    const observer = new ResizeObserver((entries) => {
      const box = entries[entries.length - 1]?.contentRect;
      if (box) setFolded(isFolded(box.width));
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  return [ref, folded];
}
