/*
 * The three colors a WebGL visualizer paints with, flattened for a vec3[3] uniform. They come from the
 * cover's dominant palette; a missing or near-gray cover falls back to soft cyan and graphite. The
 * visualizers own this palette the way the aurora owns its tint: art-derived color, not chrome.
 */

// -- Type Imports --
import type { Palette } from "../../covers/useCoverPalette";

const FALLBACK: Palette = [
  [79, 184, 212],
  [138, 138, 152],
  [159, 211, 226],
];

/** Flattens up to three sRGB triples into nine 0..1 floats, reusing the dominant for any missing slot. */
export function paletteFloats(palette: Palette | null): Float32Array {
  const source = palette && palette.length > 0 ? palette : FALLBACK;
  const out = new Float32Array(9);
  for (let i = 0; i < 3; i++) {
    const [r, g, b] = source[Math.min(i, source.length - 1)];
    out.set([r / 255, g / 255, b / 255], i * 3);
  }
  return out;
}
