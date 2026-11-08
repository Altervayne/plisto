/*
 * Placement math for the context menu: pure geometry that opens the menu from the pointer, rightward
 * and downward by default, and reverses each axis when the menu would spill past the viewport so a
 * corner press opens back into the screen. It then clamps both axes into the edge margin. It also
 * places a side panel beside the menu. No DOM and no framework, so it stays deterministic and testable
 * on its own.
 */

export interface Point {
  x: number;
  y: number;
}

export interface Size {
  width: number;
  height: number;
}

export interface Viewport {
  width: number;
  height: number;
}

export interface MenuPlacement {
  left: number;
  top: number;
  /** The corner the menu grew from, as a CSS transform-origin ("left top", "right bottom", ...). */
  origin: string;
}

/** Bounds a value to [min, max], and pins to min when the span is narrower than the menu. */
function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(min, max), Math.max(min, value));
}

/**
 * The menu's top-left for a right-click at `point`. Each axis grows away from the pointer toward the
 * far edge; when that would overflow, the axis flips to grow back toward the near edge instead. The
 * result is clamped so a menu larger than the space still stays inside the margin. `forceFlip` grows an
 * axis back toward the near edge even when there is room, for a menu anchored to a trigger. `origin` reports the
 * pointer-side corner the menu grew from, so the enter animation can scale out of the click point.
 */
export function placeMenu(
  point: Point,
  menu: Size,
  viewport: Viewport,
  margin: number,
  forceFlip: { x?: boolean; y?: boolean } = {},
): MenuPlacement {
  let left = point.x;
  const flipX = forceFlip.x === true || left + menu.width > viewport.width - margin;
  if (flipX) left = point.x - menu.width;
  left = clamp(left, margin, viewport.width - margin - menu.width);

  let top = point.y;
  const flipY = forceFlip.y === true || top + menu.height > viewport.height - margin;
  if (flipY) top = point.y - menu.height;
  top = clamp(top, margin, viewport.height - margin - menu.height);

  // Unflipped the menu opens down-right of the pointer, anchored at its top-left; each flip swings the
  // origin to the opposite edge so it always emanates from the corner nearest the click.
  const origin = `${flipX ? "right" : "left"} ${flipY ? "bottom" : "top"}`;

  return { left, top, origin };
}

/** The edges of an on-screen box, as `getBoundingClientRect` reports them. */
export interface Box {
  left: number;
  top: number;
  right: number;
  bottom: number;
}

// Space between the menu and a side panel, and how far the panel's top rises above its row.
const BESIDE_GAP = 6;
const BESIDE_LIFT = 8;

/**
 * The top-left of a side panel opened from a menu row: right of the menu with its top just above the
 * row, so the panel's first line sits level with the row. It flips to the menu's left when the right side
 * is short, then clamps both axes into the margin, overlapping the menu in a window too narrow for both.
 */
export function placeBeside(menu: Box, row: Box, panel: Size, viewport: Viewport, margin: number): Point {
  let x = menu.right + BESIDE_GAP;
  if (x + panel.width > viewport.width - margin) x = menu.left - BESIDE_GAP - panel.width;
  x = clamp(x, margin, viewport.width - margin - panel.width);
  const y = clamp(row.top - BESIDE_LIFT, margin, viewport.height - margin - panel.height);
  return { x, y };
}
