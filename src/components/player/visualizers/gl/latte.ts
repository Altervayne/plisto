/*
 * Latte, a cover scene. TODO: draw the scene; the pass paints only the stage ground.
 */

// -- Local Imports --
import { COZY_PRELUDE } from "./cozy";
import { setFluid } from "./fluid";
import { FS_VS } from "./shaders";

// -- Type Imports --
import type { Candidate, Frame, Kit } from "./kit";

const FS = `${COZY_PRELUDE}
void main() { outColor = vec4(uGround, 1.0); }`;

export function createLatte(kit: Kit): Candidate {
  return {
    mode: "image",
    bloom: 0,
    exposure: 1,
    inkGain: 1,
    trail: null,
    vignette: 0,
    draw(f: Frame) {
      if (!f.cover) return;
      const p = kit.program("latte", FS_VS, FS);
      setFluid(kit, p, f, 0, null, null);
      kit.drawQuad();
    },
    dispose() {},
  };
}
