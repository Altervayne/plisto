/*
 * Size geometry for the resizable regions: pure math mapping a drag distance onto a panel width or a
 * band height, plus the container-relative upper bounds that keep the neighbour from collapsing. No
 * DOM and no framework, so it stays deterministic and testable on its own.
 */

// Narrowest the panel can shrink to, in pixels.
export const MIN_WIDTH = 320;
// Widest the panel may ever grow, before the container-relative bound applies.
export const MAX_ABS = 560;
// Fallback width when no preference has been stored yet.
export const DEFAULT_WIDTH = 380;

// Shortest the folder band may cap to, in pixels.
export const BAND_MIN = 88;
// Tallest the band may ever cap, before the nav-relative bound applies.
export const BAND_MAX_ABS = 460;
// Fallback cap when no preference has been stored yet.
export const BAND_DEFAULT = 216;

/**
 * A dragged size after adding a signed pixel delta to the start, clamped to [min, max]. The base for
 * both resizers: each maps its own drag direction onto the delta's sign before calling in.
 */
export function sizeForDrag(start: number, delta: number, min: number, max: number): number {
  return clamp(start + delta, min, max);
}

/**
 * The panel width after dragging the handle a given pixel distance. The handle sits at the panel's
 * left edge and the panel is on the right, so a leftward drag (negative deltaX) widens it and a
 * rightward drag narrows it. Clamped to [min, max].
 */
export function widthForDrag(startWidth: number, deltaX: number, min: number, max: number): number {
  return sizeForDrag(startWidth, -deltaX, min, max);
}

/**
 * The widest the panel may grow inside a container of the given width: the absolute cap, or 44% of
 * the container when that is tighter, so the grid keeps at least a couple of columns on a wide window.
 * Never drops below MIN_WIDTH - on a narrow window the 44% share would fall under the minimum, which
 * would invert the [min, max] bound and strand the panel below its floor; the min wins there instead.
 */
export function maxWidth(containerWidth: number): number {
  return Math.max(MIN_WIDTH, Math.min(MAX_ABS, Math.round(containerWidth * 0.44)));
}

/**
 * The tallest the band may cap inside a nav column of the given height: the absolute cap, or 60% of
 * the nav when that is tighter, so the track grid always keeps a workable share of the column. Never
 * drops below BAND_MIN, so a short column cannot invert the band's bound.
 */
export function bandMaxHeight(navHeight: number): number {
  return Math.max(BAND_MIN, Math.min(BAND_MAX_ABS, Math.round(navHeight * 0.6)));
}

/** Bounds a value to [min, max]. */
export function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
