/*
 * The shared prelude of the whole-stage scenes: the fluid prelude plus the two names the scene shaders
 * were written against. `uLevel` carries the eased level, the same value the common uniforms send as
 * `uRms`, and `uBackdrop` is a constant: no scene draws a separate backdrop layer.
 */

// -- Local Imports --
import { FLUID_PRELUDE, setFluid } from "./fluid";

// -- Type Imports --
import type { Frame, Kit, Program } from "./kit";

/** The uniforms and helpers every whole-stage scene pass starts from. */
export const SCENE_PRELUDE = `${FLUID_PRELUDE}
uniform float uLevel;
const float uBackdrop = 0.0;
`;

/** Sets the uniforms a scene pass reads: the fluid set, and the eased level as `uLevel`. */
export function setScene(
  kit: Kit,
  p: Program,
  f: Frame,
  flow: number,
  rings: Float32Array | null,
  coverTex: WebGLTexture | null,
): void {
  setFluid(kit, p, f, flow, rings, coverTex);
  kit.set1(p, "uLevel", f.sig.level);
}
