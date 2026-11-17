/*
 * Pure parts of the owner's screenshot cross-check: where the four registration marks go around the two
 * stages, and what to do with a paste. The marks sit outside both slots on whole device pixels, so a
 * window snip locates the marked region and the stages inside it from the layout alone.
 */

// -- Local Imports --
import { snapCss } from "./stage";

// -- Type Imports --
import type { Rect } from "./pixelDiff";
import type { PastedLayout } from "./types";

/** Side of a registration mark in CSS pixels. */
export const MARK_CSS_PX = 8;
/** Clear space between a mark and the nearest slot edge, in CSS pixels. */
export const MARK_GAP_PX = 8;

export interface MarkPlacement {
  /** Top-left, top-right, bottom-left, bottom-right, in viewport CSS pixels. */
  marks: Rect[];
  /** What the marks span, outer edges included, in viewport CSS pixels. */
  region: Rect;
  /** The stages relative to the region; it does not change when the page scrolls. */
  layout: PastedLayout;
}

/** The marks around the union of two slot rectangles, snapped to whole device pixels. */
export function placeMarks(reference: Rect, subject: Rect, dpr: number): MarkPlacement {
  const reach = MARK_GAP_PX + MARK_CSS_PX;
  const left = snapCss(Math.min(reference.x, subject.x) - reach, dpr);
  const top = snapCss(Math.min(reference.y, subject.y) - reach, dpr);
  const right = snapCss(Math.max(reference.x + reference.w, subject.x + subject.w) + reach, dpr);
  const bottom = snapCss(Math.max(reference.y + reference.h, subject.y + subject.h) + reach, dpr);
  const m = MARK_CSS_PX;
  const marks: Rect[] = [
    { x: left, y: top, w: m, h: m },
    { x: right - m, y: top, w: m, h: m },
    { x: left, y: bottom - m, w: m, h: m },
    { x: right - m, y: bottom - m, w: m, h: m },
  ];
  const within = (r: Rect): Rect => ({ x: r.x - left, y: r.y - top, w: r.w, h: r.h });
  return {
    marks,
    region: { x: left, y: top, w: right - left, h: bottom - top },
    layout: { region: { w: right - left, h: bottom - top }, reference: within(reference), subject: within(subject) },
  };
}

export type PasteRoute = { kind: "image"; index: number } | { kind: "ignored"; line: string };

/** Decides what a paste is: the first image among the clipboard item types, else ignored with the reason. */
export function routePaste(holding: boolean, itemTypes: readonly string[]): PasteRoute {
  if (!holding) return { kind: "ignored", line: "paste ignored: no case is held" };
  const index = itemTypes.findIndex((t) => t.startsWith("image/"));
  if (index < 0) return { kind: "ignored", line: "paste ignored: the clipboard holds no image" };
  return { kind: "image", index };
}
