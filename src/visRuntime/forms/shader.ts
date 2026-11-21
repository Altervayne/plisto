/*
 * The shader form: one fragment source over the cozy prelude, drawn as a single feedback pass. The
 * prelude adds the eased level, the previous frame as `uPrev`, the fine spectrum as `uFine`, and one
 * uniform per declared setting. `#line 1` follows the prelude, so compile errors name the author's lines.
 */

// -- Local Imports --
import { sceneForm } from "./scene";
import { COZY_PRELUDE } from "../../components/player/visualizers/gl/cozy";
import { FINE_BAND_COUNT } from "../../types";

// -- Type Imports --
import type { VisFrame } from "../frame";
import type { Registration } from "../lifecycle";
import type { VisSettingShape } from "../protocol";
import type { Kit, Program } from "../../components/player/visualizers/gl/kit";

export interface ShaderSpec {
  source: string;
  mode?: "glow" | "image";
  bloom?: number;
  exposure?: number;
  inkGain?: number;
  vignette?: number;
}

/** The uniform a setting arrives in: its id with anything outside [A-Za-z0-9_] turned to `_`. */
export function settingUniform(id: string): string {
  return `uSetting_${id.replace(/[^A-Za-z0-9_]/g, "_")}`;
}

/** The prelude a shader kind's source compiles after, ending in `#line 1`. */
export function shaderPrelude(shapes: VisSettingShape[]): string {
  const settings = shapes
    .map((s) => `uniform ${s.type === "color" ? "vec3" : "float"} ${settingUniform(s.id)};`)
    .join("\n");
  return `${COZY_PRELUDE}
uniform float uLevel;
uniform sampler2D uPrev;
uniform float uFine[${FINE_BAND_COUNT}];
${settings}
#line 1
`;
}

const hexColor = (value: string): [number, number, number] | null => {
  const m = /^#([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(value);
  return m ? [parseInt(m[1], 16) / 255, parseInt(m[2], 16) / 255, parseInt(m[3], 16) / 255] : null;
};

/** Sets each declared setting's uniform: a toggle as 0 or 1, a choice as its option's index. */
function setSettings(kit: Kit, p: Program, frame: VisFrame, shapes: VisSettingShape[]): void {
  for (const shape of shapes) {
    const value = frame.settings[shape.id];
    const name = settingUniform(shape.id);
    if (shape.type === "color") {
      const rgb = value === "cover" ? [frame.palette[0], frame.palette[1], frame.palette[2]] : hexColor(String(value));
      const loc = kit.uniform(p, name);
      if (loc && rgb) kit.gl.uniform3f(loc, rgb[0], rgb[1], rgb[2]);
    } else if (shape.type === "choice") {
      kit.set1(p, name, Math.max(0, (shape.options ?? []).indexOf(String(value))));
    } else if (shape.type === "toggle") {
      kit.set1(p, name, value === true ? 1 : 0);
    } else {
      kit.set1(p, name, typeof value === "number" ? value : 0);
    }
  }
}

export function shaderForm(spec: ShaderSpec): Registration {
  if (typeof spec?.source !== "string") throw new Error("a shader visualizer needs its source");
  return (init) => {
    const shapes = init.settingShapes;
    const fine = new Float32Array(FINE_BAND_COUNT);
    return sceneForm({
      passes: [{ name: "main", fs: shaderPrelude(shapes) + spec.source, feedback: true }],
      mode: spec.mode,
      bloom: spec.bloom,
      exposure: spec.exposure,
      inkGain: spec.inkGain,
      vignette: spec.vignette,
      uniforms(_pass, p, kit, frame) {
        fine.fill(0);
        if (frame.fine) fine.set(frame.fine.slice(0, FINE_BAND_COUNT));
        const loc = kit.uniform(p, "uFine");
        if (loc) kit.gl.uniform1fv(loc, fine);
        setSettings(kit, p, frame, shapes);
      },
    })(init);
  };
}
