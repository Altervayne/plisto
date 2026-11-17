/*
 * Pure helpers of the stage replica: placing an edge on a whole device pixel, and naming what makes an
 * element a stacking context, which would cut a blend off from the layers beneath it.
 */

/** A CSS length rounded to a whole number of device pixels. */
export function snapCss(px: number, dpr: number): number {
  return Math.round(px * dpr) / dpr;
}

/** The CSS shift that moves an edge at `edge` onto the nearest whole device pixel. */
export function gridShift(edge: number, dpr: number): number {
  return Math.round(edge * dpr) / dpr - edge;
}

/** Removes every child of `node`. */
export function clearChildren(node: { firstChild: unknown; removeChild(child: never): unknown }): void {
  while (node.firstChild) node.removeChild(node.firstChild as never);
}

export interface StackingStyle {
  position: string;
  zIndex: string;
  opacity: string;
  transform: string;
  filter: string;
  backdropFilter: string;
  isolation: string;
  mixBlendMode: string;
  willChange: string;
  contain: string;
}

/** The properties of `style` that make its element a stacking context; empty when none does. */
export function stackingReasons(style: StackingStyle): string[] {
  const reasons: string[] = [];
  if (parseFloat(style.opacity) < 1) reasons.push(`opacity ${style.opacity}`);
  if (style.transform !== "none") reasons.push("transform");
  if (style.filter !== "none") reasons.push("filter");
  if (style.backdropFilter && style.backdropFilter !== "none") reasons.push("backdrop-filter");
  if (style.isolation === "isolate") reasons.push("isolation");
  if (style.mixBlendMode !== "normal") reasons.push(`mix-blend-mode ${style.mixBlendMode}`);
  if (style.zIndex !== "auto" && style.position !== "static") reasons.push(`z-index ${style.zIndex}`);
  if (/\b(opacity|transform|filter|isolation)\b/.test(style.willChange)) reasons.push("will-change");
  if (/\b(paint|layout|strict|content)\b/.test(style.contain)) reasons.push("contain");
  return reasons;
}

/** The ancestors from `slot` up to `panel` (exclusive of the slot, inclusive of the panel) that form a stacking context. */
export function stackingBreaks(slot: HTMLElement, panel: HTMLElement): string[] {
  const found: string[] = [];
  for (let el = slot.parentElement; el; el = el.parentElement) {
    const reasons = stackingReasons(getComputedStyle(el));
    if (reasons.length) found.push(`${el.tagName.toLowerCase()}.${el.className}: ${reasons.join(", ")}`);
    if (el === panel) break;
  }
  return found;
}
