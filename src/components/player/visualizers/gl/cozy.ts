/*
 * The shared kit for the cozy visualizers: the fluid prelude plus the helpers more than one scene uses, and a
 * seeded random source so a scene's choices replay the same way.
 */

// -- Local Imports --
import { FLUID_PRELUDE } from "./fluid";

/** The fluid prelude with a soft disc and a vignette weight. */
export const COZY_PRELUDE = `${FLUID_PRELUDE}
// Soft disc, 1 inside, 0 outside, feather as a share of the radius.
float disc(vec2 d, float r, float feather) { return 1.0 - smoothstep(r * (1.0 - feather), r, length(d)); }
// Vignette weight, 1 at the centre to 0 at the corners.
float vig(vec2 fc) { vec2 su = fc / uRes; return smoothstep(1.15, 0.25, length((su - 0.5) * vec2(1.1, 1.0))); }
`;

/** Clamps to 0..1. */
export function clamp01(v: number): number {
  return Math.min(1, Math.max(0, v));
}

/** A mulberry32 generator: a function returning the next float in [0, 1) for a seed. */
export function createRng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
