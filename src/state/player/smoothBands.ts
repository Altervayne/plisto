/*
 * The per-band easing the visualizers run each frame. Kept free of imports so the plugin visualizer
 * runtime can bundle it without the app's spectrum feed.
 */

/**
 * Eases `prev` toward `target` per band: a band that rose moves by the `attack` fraction of the gap
 * (fast), a band that fell by the `decay` fraction (slow), so bars snap up and settle down. Pure and
 * deterministic. A length mismatch restarts from a zero frame of the target's length, so a band-count
 * change never blends against a stale buffer.
 */
export function smoothBands(
  prev: number[],
  target: number[],
  attack: number,
  decay: number,
): number[] {
  const base = prev.length === target.length ? prev : new Array(target.length).fill(0);
  return target.map((t, i) => {
    const p = base[i];
    const rate = t > p ? attack : decay;
    return p + (t - p) * rate;
  });
}
