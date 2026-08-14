/*
 * Thumb geometry for the bespoke scrollbar: pure math mapping a viewport's scroll metrics onto the
 * thumb's size and offset along its track, and the inverse for a drag. No DOM and no framework, so
 * it stays deterministic and testable on its own.
 */

/** The scroll metrics one axis of a viewport reports, plus the track the thumb travels within. */
export interface ScrollMetrics {
  // Visible length of the viewport along the scroll axis.
  viewport: number;
  // Full scrollable length of the content along the same axis.
  content: number;
  // Current scroll position, from 0 to content - viewport.
  scroll: number;
  // Length of the track the thumb slides along.
  track: number;
  // Smallest thumb the pointer can still grab.
  minThumb: number;
}

/** A resolved thumb: its length and its distance from the track start. */
export interface ThumbGeometry {
  size: number;
  offset: number;
}

/**
 * The thumb size and offset for the given metrics, or null when the content fits the viewport
 * (nothing to scroll, so no thumb shows). Size follows the visible fraction, floored at minThumb;
 * offset maps the scroll position onto the leftover track travel and is clamped to it.
 */
export function thumbGeometry(m: ScrollMetrics): ThumbGeometry | null {
  const { viewport, content, scroll, track, minThumb } = m;

  // Content fits, or the track has not been measured yet: no scrollbar.
  if (content <= viewport || track <= 0) return null;

  const rawSize = (viewport / content) * track;
  const size = Math.min(track, Math.max(minThumb, rawSize));

  const maxScroll = content - viewport;
  const travel = track - size;
  // A thumb as long as its track has nowhere to travel: pin it to the start.
  const offset = maxScroll > 0 && travel > 0 ? clamp((scroll / maxScroll) * travel, 0, travel) : 0;

  return { size, offset };
}

/**
 * The scroll delta produced by dragging the thumb a given pixel distance along its track. The
 * inverse of the offset map: a full-track drag covers the whole content range. Zero when there is
 * nothing to scroll.
 */
export function scrollDeltaForDrag(thumbDelta: number, m: ScrollMetrics): number {
  const geo = thumbGeometry(m);
  if (!geo) return 0;

  const travel = m.track - geo.size;
  if (travel <= 0) return 0;

  return (thumbDelta / travel) * (m.content - m.viewport);
}

/** Bounds a value to [min, max]. */
function clamp(value: number, min: number, max: number): number {
  return Math.min(max, Math.max(min, value));
}
