/*
 * The waveform zoom math, framework-free so it stays testable. Zoom is a continuous pixels-per-second
 * scale: fit maps the whole file to the viewport, and finer values widen the virtual lane past it. The
 * bounds and the anchor scroll both need the viewport, the duration, and the lane width at once, so
 * they live here as one set of pure helpers the lane calls.
 */

/** Each wheel notch or key press scales the zoom by this factor, so steps read even across the range. */
export const ZOOM_STEP = 1.3;

/** The widest the backing lane may grow, kept within a device-pixel-safe canvas at any DPR. */
export const SAFE_MAX_LANE_PX = 16384;

/** A hard ceiling on how far a short file may zoom, so it never widens to an absurd sliver. */
export const ABSOLUTE_CEIL = 400;

/** Fit: the whole file across the viewport. A zero viewport or duration has no scale yet, so zero. */
export function fitPxPerSec(viewportW: number, durationSecs: number): number {
  if (viewportW <= 0 || durationSecs <= 0) return 0;
  return viewportW / durationSecs;
}

/**
 * The finest zoom: the canvas-safe width over the duration, held under the absolute ceiling, but never
 * below fit - a file too short to reach either bound simply cannot zoom.
 */
export function maxPxPerSec(durationSecs: number, fit: number): number {
  if (durationSecs <= 0) return fit;
  return Math.max(fit, Math.min(ABSOLUTE_CEIL, SAFE_MAX_LANE_PX / durationSecs));
}

/** Clamps a scale into [fit, max]. Fit is the floor, so the whole file always fits at the low end. */
export function clampPxPerSec(px: number, fit: number, max: number): number {
  return Math.min(max, Math.max(fit, px));
}

/** One geometric step: widen in, narrow out. The caller clamps the result to the current bounds. */
export function stepPxPerSec(px: number, dir: 1 | -1): number {
  return dir > 0 ? px * ZOOM_STEP : px / ZOOM_STEP;
}

/** The span of file time the viewport shows at a given scale, in seconds. */
export function secondsVisible(viewportW: number, pxPerSec: number): number {
  if (pxPerSec <= 0) return 0;
  return viewportW / pxPerSec;
}

/**
 * The scroll offset that pins `anchorSecs` under a fixed viewport offset after a zoom, so the focus
 * point never teleports. Solves scroll so the anchor's lane pixel lands back at `offsetInViewport`,
 * clamped to the scrollable range.
 */
export function anchorScrollLeft(
  anchorSecs: number,
  pxPerSec: number,
  offsetInViewport: number,
  laneWidth: number,
  viewportW: number,
): number {
  const max = Math.max(0, laneWidth - viewportW);
  return Math.min(max, Math.max(0, anchorSecs * pxPerSec - offsetInViewport));
}

/** The compact readout: whole seconds under a minute, m:ss at or past it. */
export function formatVisible(secs: number): string {
  const rounded = Math.max(0, Math.round(secs));
  if (rounded >= 60) {
    const m = Math.floor(rounded / 60);
    const s = rounded % 60;
    return `${m}:${s.toString().padStart(2, "0")}`;
  }
  return `${rounded}s`;
}
