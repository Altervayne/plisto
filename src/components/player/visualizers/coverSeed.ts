/*
 * The cover seed's layout: the blooms a coverless track's generated image is painted from, and the
 * palette taken from them. Pure and keyed on the track id, so a track always gets the same seed.
 */

// -- Type Imports --
import type { Palette } from "../../covers/useCoverPalette";

// -- Local Imports --
import { createRng } from "./gl/cozy";

// The brand staff's stop-0 colours, one bloom each.
export const STAFF_COLORS: Palette = [
  [229, 72, 126],
  [242, 168, 30],
  [84, 178, 76],
  [30, 156, 192],
  [122, 86, 208],
];

// Where each bloom sits before the per-track jitter, as shares of the side.
export const BLOOM_ANCHORS: [number, number][] = [
  [0.15, 0.2],
  [0.85, 0.15],
  [0.9, 0.8],
  [0.2, 0.85],
  [0.5, 0.5],
];

// The per-track variation: how far a bloom moves (share of the side), and the radius and strength ranges.
// Kept small so every track stays balanced around the logo while its mood still differs.
export const JITTER = 0.12;
export const RADIUS = 0.55;
export const RADIUS_SPREAD = 0.1;
export const STRENGTH_SPREAD = 0.3;

export interface Bloom {
  // Centre as shares of the side.
  x: number;
  y: number;
  // Radius as a share of the side.
  r: number;
  // Strength multiplier around 1.
  a: number;
  color: [number, number, number];
}

export interface SeedLayout {
  blooms: Bloom[];
  palette: Palette;
}

/** A 32-bit avalanche hash of a track id. */
export function hash32(n: number): number {
  let h = (n ^ 0x9e3779b9) >>> 0;
  h = Math.imul(h ^ (h >>> 16), 0x85ebca6b);
  h = Math.imul(h ^ (h >>> 13), 0xc2b2ae35);
  return (h ^ (h >>> 16)) >>> 0;
}

/** The blooms for `trackId`: colours shuffled across the anchors, each anchor, radius and strength nudged. */
export function seedLayout(trackId: number): SeedLayout {
  const rnd = createRng(hash32(trackId));
  const spread = () => rnd() * 2 - 1;
  const order = STAFF_COLORS.map((_, i) => i);
  for (let i = order.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    [order[i], order[j]] = [order[j], order[i]];
  }
  const blooms = BLOOM_ANCHORS.map(
    ([ax, ay], i): Bloom => ({
      x: ax + spread() * JITTER,
      y: ay + spread() * JITTER,
      r: RADIUS + spread() * RADIUS_SPREAD,
      a: 1 + spread() * STRENGTH_SPREAD,
      color: STAFF_COLORS[order[i]],
    }),
  );
  const palette = [...blooms]
    .sort((p, q) => q.a * q.r - p.a * p.r)
    .slice(0, 3)
    .map((b) => b.color);
  return { blooms, palette };
}

/** The visualizer palette of a coverless track: its three strongest blooms. */
export function seedPalette(trackId: number): Palette {
  return seedLayout(trackId).palette;
}
