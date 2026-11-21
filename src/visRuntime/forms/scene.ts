/*
 * The scene form: one or more full-screen passes over the scene prelude, drawn in order. The last pass
 * draws into the stage's scene buffer unless it keeps its own; every other pass draws into a buffer of
 * its own, which later passes sample by its name. A feedback pass keeps a pair of buffers and reads its
 * previous output as `uPrev`. Every pass gets the scene uniforms; `uniforms` adds a pass's own.
 */

// -- Local Imports --
import { createCoverTexture } from "../../components/player/visualizers/gl/coverTexture";
import { createRings } from "../../components/player/visualizers/gl/fluid";
import { setScene } from "../../components/player/visualizers/gl/scene";
import { FS_VS } from "../../components/player/visualizers/gl/shaders";

// -- Type Imports --
import type { VisFrame } from "../frame";
import type { Registration } from "../lifecycle";
import type {
  Candidate,
  Kit,
  Program,
  ProgramSource,
  Target,
  Trail,
} from "../../components/player/visualizers/gl/kit";

export interface ScenePass {
  name: string;
  // The whole fragment source; the vertex stage is the full-screen triangle.
  fs: string;
  // Keeps a pair of buffers and reads its previous output as `uPrev`.
  feedback?: boolean;
  // A pass with its own buffer sizes it at this share of the stage, 0..1.
  scale?: number;
  // Earlier passes this one samples, each bound as a sampler named after the pass.
  inputs?: string[];
  // "add" blends onto what the buffer holds; the default replaces it.
  blend?: "replace" | "add";
}

export interface SceneSpec<S> {
  passes: ScenePass[];
  mode?: "glow" | "image";
  bloom?: number;
  exposure?: number;
  inkGain?: number;
  vignette?: number;
  trail?: Trail | null;
  // Beat rings for the fluid uniforms: life and rise in seconds, height per unit of beat.
  rings?: { life: number; rise: number; height: number };
  init?: (kit: Kit) => S;
  // Advances the state once per frame; the number it returns is the fluid flow.
  update?: (frame: VisFrame, state: S) => number | void;
  // Sets a pass's own uniforms while its program is in use.
  uniforms?: (pass: string, program: Program, kit: Kit, frame: VisFrame, state: S) => void;
  dispose?: (state: S, kit: Kit) => void;
}

/** A pass's own buffers: one, or a pair for feedback. */
interface PassBuffers {
  targets: Target[];
  current: number;
}

const COPY_PROGRAM: ProgramSource = {
  name: "scene:copy",
  vs: FS_VS,
  fs: `#version 300 es
precision highp float;
in vec2 vUv;
uniform sampler2D uSrc;
out vec4 outColor;
void main() { outColor = texture(uSrc, vUv); }`,
};

const programOf = (pass: ScenePass): ProgramSource => ({ name: `scene:${pass.name}`, vs: FS_VS, fs: pass.fs });

// A pass name becomes a sampler uniform name, so it must be one GLSL accepts.
const GLSL_IDENT = /^[A-Za-z_][A-Za-z0-9_]*$/;

function checkPassName(name: string): void {
  if (!GLSL_IDENT.test(name)) throw new Error(`pass name "${name}" is not a valid GLSL identifier`);
  if (name === "main") throw new Error('pass name "main" is reserved: a pass name cannot be main');
  if (name.startsWith("gl_")) throw new Error(`pass name "${name}" cannot start with gl_`);
}

function checkPasses(passes: ScenePass[]): void {
  if (!Array.isArray(passes) || passes.length === 0) throw new Error("a scene needs at least one pass");
  const seen = new Set<string>();
  for (const pass of passes) {
    if (typeof pass.name !== "string" || typeof pass.fs !== "string") throw new Error("a pass needs a name and fs");
    checkPassName(pass.name);
    if (seen.has(pass.name)) throw new Error(`pass ${pass.name} is declared twice`);
    for (const input of pass.inputs ?? []) {
      if (!seen.has(input)) throw new Error(`pass ${pass.name} samples ${input}, which does not draw before it`);
    }
    seen.add(pass.name);
  }
}

export function sceneForm<S>(spec: SceneSpec<S>): Registration {
  checkPasses(spec.passes);
  const passes = spec.passes;
  const programs = passes.map(programOf);
  const last = passes[passes.length - 1];
  if (last.feedback) programs.push(COPY_PROGRAM);
  return () => ({ form: "gl", programs, factory: (kit) => sceneCandidate(kit, spec, programs) });
}

function sceneCandidate<S>(kit: Kit, spec: SceneSpec<S>, programs: ProgramSource[]): Candidate {
  const { gl } = kit;
  const passes = spec.passes;
  const lastIndex = passes.length - 1;
  const state = spec.init ? spec.init(kit) : (undefined as S);
  const cover = createCoverTexture(gl);
  const rings = spec.rings ? createRings(spec.rings.life, spec.rings.rise, spec.rings.height) : null;
  const buffers = new Map<string, PassBuffers>();
  const outputs = new Map<string, WebGLTexture>();
  let sizedFor = "";

  const freeBuffers = () => {
    for (const b of buffers.values()) b.targets.forEach(kit.freeTarget);
    buffers.clear();
  };

  // Every pass but a plain last one draws into its own buffer, rebuilt when the stage resizes.
  const fitBuffers = () => {
    const key = `${kit.size.w}x${kit.size.h}`;
    if (key === sizedFor) return;
    sizedFor = key;
    freeBuffers();
    passes.forEach((pass, i) => {
      if (i === lastIndex && !pass.feedback) return;
      const scale = Math.min(1, Math.max(0.05, pass.scale ?? 1));
      const w = Math.max(1, Math.round(kit.size.w * scale));
      const h = Math.max(1, Math.round(kit.size.h * scale));
      const count = pass.feedback ? 2 : 1;
      buffers.set(pass.name, { targets: Array.from({ length: count }, () => kit.makeTarget(w, h)), current: 0 });
    });
  };

  const setBlend = (pass: ScenePass) => {
    if (pass.blend === "add") {
      gl.enable(gl.BLEND);
      gl.blendFunc(gl.ONE, gl.ONE);
    } else {
      gl.disable(gl.BLEND);
    }
  };

  const draw = (frame: VisFrame) => {
    const scene = kit.boundTarget();
    fitBuffers();
    const flow = spec.update?.(frame, state);
    rings?.step(frame.dt, frame.sig.beat);
    const coverTex = frame.cover ? (cover.sync(frame.cover), cover.tex) : null;
    passes.forEach((pass, i) => {
      const p = kit.program(programs[i]);
      const own = buffers.get(pass.name);
      const dst = own ? own.targets[own.current] : scene;
      kit.bindTarget(dst);
      setBlend(pass);
      setScene(kit, p, frame, typeof flow === "number" ? flow : 0, rings?.packed ?? null, coverTex);
      kit.set2(p, "uPassRes", dst ? dst.w : kit.size.w, dst ? dst.h : kit.size.h);
      let unit = 1;
      for (const input of pass.inputs ?? []) {
        const tex = outputs.get(input);
        if (tex) kit.bindTex(p, input, unit++, tex);
      }
      if (own && own.targets.length === 2) kit.bindTex(p, "uPrev", unit, own.targets[1 - own.current].tex);
      spec.uniforms?.(pass.name, p, kit, frame, state);
      kit.drawQuad();
      if (own) {
        outputs.set(pass.name, own.targets[own.current].tex);
        own.current = (own.current + 1) % own.targets.length;
      }
    });
    const lastOwn = outputs.get(passes[lastIndex].name);
    if (passes[lastIndex].feedback && lastOwn) {
      const copy = kit.program(COPY_PROGRAM);
      kit.bindTarget(scene);
      setBlend(passes[lastIndex]);
      gl.useProgram(copy.handle);
      kit.bindTex(copy, "uSrc", 0, lastOwn);
      kit.drawQuad();
    }
    gl.disable(gl.BLEND);
  };

  return {
    mode: spec.mode ?? "glow",
    bloom: spec.bloom ?? 0,
    exposure: spec.exposure ?? 1,
    inkGain: spec.inkGain ?? 1,
    trail: spec.trail ?? null,
    vignette: spec.vignette,
    draw: (f) => draw(f as VisFrame),
    dispose() {
      freeBuffers();
      cover.dispose();
      spec.dispose?.(state, kit);
    },
  };
}
