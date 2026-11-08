/*
 * The filmstrip's scroll math, pure so the feel's numbers are tested apart from the DOM: how a wheel
 * event moves the strip, where its edge fades show, which group chip reads as current, and where the
 * strip opens. Positions are scroll offsets in px, measured from the strip's padding edge.
 */

/** A tile's width in the strip. */
export const TILE_WIDTH = 170;
/** A tile plus the gap to the next one inside a group: what one wheel notch moves. */
export const TILE_STEP = 178;
/** The strip's inline padding: a group scrolled to the left edge sits this far in. */
export const STRIP_PAD = 4;
/** What a chevron press scrolls. */
export const CHEVRON_STEP = 560;
/** The edge fades' widths while more tiles lie beyond that edge. */
export const FADE_LEFT = 22;
export const FADE_RIGHT = 28;

// A pixel delta this large is a mouse wheel notch, not a trackpad's stream of small deltas.
const NOTCH_PX = 50;
// The share of the remaining distance an eased notch covers each frame.
const WHEEL_EASE = 0.22;
// Offsets this close to an end count as the end.
const END_SLACK = 2;
// A group reads as current once its left edge comes this close to the strip's left edge.
const CHIP_LEAD = 40;
// Within this of the far end, the last group reads as current, even though it cannot reach the left edge.
const CHIP_END_SLACK = 4;

const clamp = (value: number, max: number) => Math.min(Math.max(0, max), Math.max(0, value));

/** The parts of a wheel event the strip reads. */
export interface WheelInput {
  deltaX: number;
  deltaY: number;
  // 0 for pixels; line and page modes come from a notched wheel.
  deltaMode: number;
}

/** Where the strip stands when a wheel event lands. */
export interface StripScroll {
  scroll: number;
  max: number;
  // The target an eased notch is still heading for, so quick notches add up.
  easing: number | null;
}

/**
 * What a wheel event does: a horizontal-dominant delta is left to the browser, a trackpad's small vertical
 * delta scrolls 1:1, and a notch eases one tile on.
 */
export type WheelMove = { kind: "native" } | { kind: "direct"; to: number } | { kind: "ease"; to: number };

export function wheelStep(e: WheelInput, at: StripScroll): WheelMove {
  if (Math.abs(e.deltaY) <= Math.abs(e.deltaX)) return { kind: "native" };
  const notch = e.deltaMode !== 0 || Math.abs(e.deltaY) >= NOTCH_PX;
  if (!notch) return { kind: "direct", to: clamp(at.scroll + e.deltaY, at.max) };
  const from = at.easing ?? at.scroll;
  return { kind: "ease", to: clamp(from + Math.sign(e.deltaY) * TILE_STEP, at.max) };
}

/** One frame of an eased notch: the next offset, which lands exactly on the target once within a pixel. */
export function easeStep(scroll: number, target: number): number {
  const remaining = target - scroll;
  return Math.abs(remaining) < 1 ? target : scroll + remaining * WHEEL_EASE;
}

/** The edge fades' widths: each shows only while more of the strip lies beyond that edge. */
export function fadeState(scroll: number, max: number): { left: number; right: number } {
  return {
    left: scroll > END_SLACK ? FADE_LEFT : 0,
    right: scroll < max - END_SLACK ? FADE_RIGHT : 0,
  };
}

/** The index of the group whose chip reads as current, from the groups' left offsets in strip order. */
export function chipAt(scroll: number, groupOffsets: readonly number[], max: number): number {
  if (groupOffsets.length === 0) return 0;
  if (scroll >= max - CHIP_END_SLACK) return groupOffsets.length - 1;
  let current = 0;
  groupOffsets.forEach((left, i) => {
    if (left - CHIP_LEAD <= scroll) current = i;
  });
  return current;
}

/** The offset that brings a group's heading to the strip's left edge. */
export function groupScroll(groupLeft: number, max: number): number {
  return clamp(groupLeft - STRIP_PAD, max);
}

/** The geometry the strip opens on: the checked tile, its group, and the strip's visible width. */
export interface OpenGeometry {
  tileLeft: number;
  groupLeft: number;
  groupWidth: number;
  viewport: number;
  max: number;
}

/**
 * Where the strip opens: the checked tile's group with its heading at the left edge when the whole group
 * fits clear of the right fade, else the checked tile centred.
 */
export function openScrollTarget(g: OpenGeometry): number {
  if (STRIP_PAD + g.groupWidth <= g.viewport - FADE_RIGHT) return groupScroll(g.groupLeft, g.max);
  return clamp(g.tileLeft + TILE_WIDTH / 2 - g.viewport / 2, g.max);
}
