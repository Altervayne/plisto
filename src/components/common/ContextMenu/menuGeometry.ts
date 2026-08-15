/*
 * Placement math for the context menu: pure geometry that opens the menu from the pointer, rightward
 * and downward by default, and reverses each axis when the menu would spill past the viewport so a
 * corner press opens back into the screen. It then clamps both axes into the edge margin. No DOM and
 * no framework, so it stays deterministic and testable on its own.
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
}

/** Bounds a value to [min, max], and pins to min when the span is narrower than the menu. */
function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(min, max), Math.max(min, value));
}

/**
 * The menu's top-left for a right-click at `point`. Each axis grows away from the pointer toward the
 * far edge; when that would overflow, the axis flips to grow back toward the near edge instead. The
 * result is clamped so a menu larger than the space still stays inside the margin.
 */
export function placeMenu(point: Point, menu: Size, viewport: Viewport, margin: number): MenuPlacement {
  let left = point.x;
  if (left + menu.width > viewport.width - margin) left = point.x - menu.width;
  left = clamp(left, margin, viewport.width - margin - menu.width);

  let top = point.y;
  if (top + menu.height > viewport.height - margin) top = point.y - menu.height;
  top = clamp(top, margin, viewport.height - margin - menu.height);

  return { left, top };
}
