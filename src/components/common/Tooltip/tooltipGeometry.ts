/*
 * Placement math for the tooltip: pure geometry that seats the bubble against a trigger rect on a
 * chosen side, flips to the opposite side when the preferred one would overflow the viewport, and
 * clamps the cross axis so the bubble never leaves the screen. No DOM and no framework, so it stays
 * deterministic and testable on its own; the component only feeds it measured rects.
 */

/** Which side of the trigger the bubble sits on. */
export type TooltipPlacement = "top" | "bottom" | "left" | "right";

export interface Rect {
  top: number;
  left: number;
  width: number;
  height: number;
}

export interface Size {
  width: number;
  height: number;
}

export interface Viewport {
  width: number;
  height: number;
}

export interface Placed {
  left: number;
  top: number;
  placement: TooltipPlacement;
}

const OPPOSITE: Record<TooltipPlacement, TooltipPlacement> = {
  top: "bottom",
  bottom: "top",
  left: "right",
  right: "left",
};

/** The bubble's top-left for a given side, centered on the trigger across that side's cross axis. */
function coordsFor(side: TooltipPlacement, trigger: Rect, bubble: Size, gap: number): { left: number; top: number } {
  const cx = trigger.left + trigger.width / 2 - bubble.width / 2;
  const cy = trigger.top + trigger.height / 2 - bubble.height / 2;
  switch (side) {
    case "top":
      return { left: cx, top: trigger.top - gap - bubble.height };
    case "bottom":
      return { left: cx, top: trigger.top + trigger.height + gap };
    case "left":
      return { left: trigger.left - gap - bubble.width, top: cy };
    case "right":
      return { left: trigger.left + trigger.width + gap, top: cy };
  }
}

/** Whether the bubble's leading edge on the placement axis stays inside the viewport margin. */
function fits(side: TooltipPlacement, left: number, top: number, bubble: Size, viewport: Viewport, margin: number): boolean {
  switch (side) {
    case "top":
      return top >= margin;
    case "bottom":
      return top + bubble.height <= viewport.height - margin;
    case "left":
      return left >= margin;
    case "right":
      return left + bubble.width <= viewport.width - margin;
  }
}

/** Bounds a value to [min, max], and pins to min when the span is narrower than the bubble. */
function clamp(value: number, min: number, max: number): number {
  return Math.min(Math.max(min, max), Math.max(min, value));
}

/**
 * Seats the bubble on the preferred side, flips to the opposite side only when the preferred one
 * overflows and the opposite one fits, then clamps the free (cross) axis into the viewport margin.
 */
export function placeTooltip(
  trigger: Rect,
  bubble: Size,
  viewport: Viewport,
  preferred: TooltipPlacement,
  gap: number,
  margin: number,
): Placed {
  let side = preferred;
  let coords = coordsFor(side, trigger, bubble, gap);

  if (!fits(side, coords.left, coords.top, bubble, viewport, margin)) {
    const opposite = OPPOSITE[side];
    const flipped = coordsFor(opposite, trigger, bubble, gap);
    if (fits(opposite, flipped.left, flipped.top, bubble, viewport, margin)) {
      side = opposite;
      coords = flipped;
    }
  }

  if (side === "top" || side === "bottom") {
    coords.left = clamp(coords.left, margin, viewport.width - margin - bubble.width);
  } else {
    coords.top = clamp(coords.top, margin, viewport.height - margin - bubble.height);
  }

  return { left: coords.left, top: coords.top, placement: side };
}
