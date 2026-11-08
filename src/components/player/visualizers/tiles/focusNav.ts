/*
 * Geometric arrow-key navigation shared by the visualizer pickers: from the focused item, the next one is
 * the nearest in the pressed direction, with sideways drift penalized so a grid or a strip moves the way
 * the eye expects.
 */

/** The box of one navigable item, in any shared coordinate space. */
export interface NavRect {
  left: number;
  top: number;
  width: number;
  height: number;
}

export type NavDirection = "ArrowLeft" | "ArrowRight" | "ArrowUp" | "ArrowDown";

// Centers closer than this along the travel axis do not count as lying in that direction.
const MIN_TRAVEL = 4;
// What a unit of sideways offset costs against a unit of travel.
const DRIFT_WEIGHT = 4;

/** The index of the item to focus after `dir` from item `here`, or null when nothing lies that way. */
export function nextFocus(rects: readonly NavRect[], here: number, dir: NavDirection): number | null {
  const from = rects[here];
  if (!from) return null;
  const hx = from.left + from.width / 2;
  const hy = from.top + from.height / 2;
  let best: number | null = null;
  let bestScore = Infinity;
  rects.forEach((r, i) => {
    if (i === here) return;
    const dx = r.left + r.width / 2 - hx;
    const dy = r.top + r.height / 2 - hy;
    let score: number | null = null;
    if (dir === "ArrowRight" && dx > MIN_TRAVEL) score = dx + DRIFT_WEIGHT * Math.abs(dy);
    else if (dir === "ArrowLeft" && dx < -MIN_TRAVEL) score = -dx + DRIFT_WEIGHT * Math.abs(dy);
    else if (dir === "ArrowDown" && dy > MIN_TRAVEL) score = dy + DRIFT_WEIGHT * Math.abs(dx);
    else if (dir === "ArrowUp" && dy < -MIN_TRAVEL) score = -dy + DRIFT_WEIGHT * Math.abs(dx);
    if (score !== null && score < bestScore) {
      best = i;
      bestScore = score;
    }
  });
  return best;
}
