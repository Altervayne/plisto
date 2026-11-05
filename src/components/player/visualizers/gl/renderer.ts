/*
 * The WebGL2 renderer behind one visualizer surface: one context on one canvas. Every candidate renders
 * into a half-float scene buffer, optionally fed back from the previous frame for trails. A shared pass
 * adds a two-level bloom and maps the result onto the stage: screen-blended light on a dark ground,
 * multiplied ink on a light one, or a straight premultiplied image for a candidate that paints real
 * color. The dot kinds paint their own ink on a light ground, so they composite straight there with no
 * bloom. Switching candidates keeps the context; only the outgoing candidate's buffers are freed.
 */

// -- Local Imports --
import { createKit, type Candidate, type Frame, type Kit, type Rect, type Target } from "./kit";
import { BLUR_FS, COMPOSITE_FS, DOWN_FS, FS_VS, TRAIL_FS } from "./shaders";
import { createBloom } from "./bloom";
import { createDotCover } from "./dotCover";
import { createDotSpectrum } from "./dotSpectrum";
import { createGlass } from "./glass";
import { createHalftone } from "./halftone";
import { createInk } from "./ink";
import { createLiquid } from "./liquid";
import { createMercury } from "./mercury";
import { createNebula } from "./nebula";
import { createSilk } from "./silk";
import { createTerrain } from "./terrain";
import { createWarp } from "./warp";

// -- State Imports --
import { fillsStage, type GlKind } from "../../../../state/player/visualizerKind";

/** The CSS blend the canvas takes over the stage for a kind and theme. */
export type BlendMode = "screen" | "multiply" | "normal";

/** Where the canvas and the cover sit, in CSS pixels with a top-left origin, relative to the canvas. */
export interface Layout {
  width: number;
  height: number;
  cover: Rect;
  radius: number;
  mask: Rect | null;
  // The top edge of the element the layer rests on, or null for none.
  floor: number | null;
  // The text blocks a visualizer may hush behind.
  hush: Rect[];
}

export interface Renderer {
  fit: (layout: Layout) => void;
  render: (kind: GlKind, frame: Frame) => void;
  // One static frame for reduced motion: pre-rolls a trail candidate on the given signal, then stops.
  still: (kind: GlKind, frame: Frame) => void;
  dispose: () => void;
}

const FACTORIES: Record<GlKind, (kit: Kit) => Candidate> = {
  terrain: createTerrain,
  liquid: createLiquid,
  warp: createWarp,
  nebula: createNebula,
  bloom: createBloom,
  halftone: createHalftone,
  "dot-spectrum": createDotSpectrum,
  "dot-cover": createDotCover,
  ink: createInk,
  mercury: createMercury,
  glass: createGlass,
  silk: createSilk,
};

const MODE_INDEX: Record<BlendMode, number> = { screen: 0, multiply: 1, normal: 2 };

/** The scene ping-pong pair, then the quarter- and eighth-size bloom pairs. */
interface Targets {
  scene0: Target;
  scene1: Target;
  q0: Target;
  q1: Target;
  e0: Target;
  e1: Target;
}

// Device pixels per CSS pixel, capped so a high-DPI screen never quadruples the fill past 2x.
const MAX_DPR = 2;
// The corner darkening ambient applies unless a candidate sets its own.
const AMBIENT_VIGNETTE = 0.35;

/**
 * The blend a kind needs: the stage-filling kinds and Dot cover paint real color; the other dot kinds
 * screen on dark and paint their own ink on light; every other glow screens on dark and multiplies on light.
 */
export function blendModeFor(kind: GlKind, light: boolean): BlendMode {
  if (fillsStage(kind) || kind === "dot-cover") return "normal";
  if (kind === "halftone" || kind === "dot-spectrum") return light ? "normal" : "screen";
  return light ? "multiply" : "screen";
}

/** Opens a WebGL2 context on `canvas`, or returns null when WebGL2 is unavailable. */
export function createRenderer(canvas: HTMLCanvasElement): Renderer | null {
  const gl = canvas.getContext("webgl2", { alpha: true, premultipliedAlpha: true, antialias: false });
  if (!gl) return null;
  const kit = createKit(gl);
  let targets: Targets | null = null;
  let current: { kind: GlKind; candidate: Candidate } | null = null;
  let flip = 0;

  const freeTargets = () => {
    if (!targets) return;
    for (const target of Object.values(targets)) kit.freeTarget(target);
    targets = null;
  };

  const resizeTargets = () => {
    freeTargets();
    const { w, h } = kit.size;
    const qw = Math.max(1, w >> 2);
    const qh = Math.max(1, h >> 2);
    const ew = Math.max(1, w >> 3);
    const eh = Math.max(1, h >> 3);
    targets = {
      scene0: kit.makeTarget(w, h),
      scene1: kit.makeTarget(w, h),
      q0: kit.makeTarget(qw, qh),
      q1: kit.makeTarget(qw, qh),
      e0: kit.makeTarget(ew, eh),
      e1: kit.makeTarget(ew, eh),
    };
  };

  const fit = (layout: Layout) => {
    const dpr = Math.min(window.devicePixelRatio || 1, MAX_DPR);
    const w = Math.max(1, Math.round(layout.width * dpr));
    const h = Math.max(1, Math.round(layout.height * dpr));
    kit.size.dpr = dpr;
    if (w !== kit.size.w || h !== kit.size.h || !targets) {
      kit.size.w = w;
      kit.size.h = h;
      canvas.width = w;
      canvas.height = h;
      resizeTargets();
    }
    // GL rects measure from the bottom-left in device pixels.
    const toGl = (r: Rect): Rect => [r[0] * dpr, h - (r[1] + r[3]) * dpr, r[2] * dpr, r[3] * dpr];
    kit.geo.cover = toGl(layout.cover);
    kit.geo.radius = layout.radius * dpr;
    kit.geo.mask = layout.mask ? toGl(layout.mask) : null;
    kit.geo.floor = layout.floor != null ? h - layout.floor * dpr : null;
    kit.geo.hush = layout.hush.map(toGl);
  };

  const bloomChain = (T: Targets, src: Target, threshold: number) => {
    const { gl: g } = kit;
    const down = kit.program("down", FS_VS, DOWN_FS);
    const blur = kit.program("blur", FS_VS, BLUR_FS);
    g.disable(g.BLEND);
    g.useProgram(down.handle);
    kit.bindTarget(T.q0);
    kit.bindTex(down, "uSrc", 0, src.tex);
    kit.set2(down, "uTexel", 1 / src.w, 1 / src.h);
    kit.set1(down, "uThreshold", threshold);
    kit.drawQuad();
    const pass = (from: Target, to: Target, dx: number, dy: number) => {
      kit.bindTarget(to);
      g.useProgram(blur.handle);
      kit.bindTex(blur, "uSrc", 0, from.tex);
      kit.set2(blur, "uDir", dx / from.w, dy / from.h);
      kit.drawQuad();
    };
    pass(T.q0, T.q1, 1.5, 0);
    pass(T.q1, T.q0, 0, 1.5);
    g.useProgram(down.handle);
    kit.bindTarget(T.e0);
    kit.bindTex(down, "uSrc", 0, T.q0.tex);
    kit.set2(down, "uTexel", 1 / T.q0.w, 1 / T.q0.h);
    kit.set1(down, "uThreshold", 0);
    kit.drawQuad();
    pass(T.e0, T.e1, 2, 0);
    pass(T.e1, T.e0, 0, 2);
  };

  const composite = (T: Targets, src: Target, mode: BlendMode, bloom: number, c: Candidate, f: Frame) => {
    const { gl: g } = kit;
    const p = kit.program("composite", FS_VS, COMPOSITE_FS);
    kit.bindTarget(null);
    g.disable(g.BLEND);
    g.useProgram(p.handle);
    kit.bindTex(p, "uScene", 0, src.tex);
    kit.bindTex(p, "uB1", 1, T.q0.tex);
    kit.bindTex(p, "uB2", 2, T.e0.tex);
    kit.seti(p, "uMode", MODE_INDEX[mode]);
    kit.set1(p, "uBloomK", bloom);
    // Ink on a light ground needs more gain than light on a dark one to read at the same weight.
    kit.set1(p, "uExposure", f.light && c.mode === "glow" ? c.exposure * c.inkGain : c.exposure);
    kit.set2(p, "uRes", kit.size.w, kit.size.h);
    kit.set1(p, "uMaskOn", kit.geo.mask && !c.fullBleed ? 1 : 0);
    kit.set4(p, "uMask", kit.geo.mask ?? [0, 0, kit.size.w, kit.size.h]);
    kit.set1(p, "uFeather", 90 * kit.size.dpr);
    kit.set1(p, "uVignette", f.ambient ? (c.vignette ?? AMBIENT_VIGNETTE) : 0);
    kit.drawQuad();
  };

  const candidateFor = (T: Targets, kind: GlKind): Candidate => {
    if (current?.kind === kind) return current.candidate;
    current?.candidate.dispose();
    current = { kind, candidate: FACTORIES[kind](kit) };
    for (const target of [T.scene0, T.scene1]) {
      kit.bindTarget(target);
      kit.gl.clearColor(0, 0, 0, 0);
      kit.gl.clear(kit.gl.COLOR_BUFFER_BIT);
    }
    return current.candidate;
  };

  const render = (kind: GlKind, f: Frame) => {
    const T = targets;
    if (!T || gl.isContextLost()) return;
    const c = candidateFor(T, kind);
    const dst = flip ? T.scene1 : T.scene0;
    const src = flip ? T.scene0 : T.scene1;
    kit.bindTarget(dst);
    gl.disable(gl.BLEND);
    if (c.trail) {
      const p = kit.program("trail", FS_VS, TRAIL_FS);
      gl.useProgram(p.handle);
      kit.set2(p, "uRes", kit.size.w, kit.size.h);
      kit.bindTex(p, "uPrev", 0, src.tex);
      const step = Math.min(3, f.dt * 60);
      kit.set1(p, "uDecay", Math.pow(c.trailDecay ? c.trailDecay(f) : c.trail.decay, step));
      const center = c.trailCenter ? c.trailCenter() : [kit.size.w / 2, kit.size.h / 2];
      kit.set2(p, "uCenter", center[0], center[1]);
      kit.set1(p, "uZoom", Math.pow(c.trailZoom ? c.trailZoom(f) : c.trail.zoom, step));
      kit.set1(p, "uRot", c.trail.rot * step);
      kit.drawQuad();
      flip = 1 - flip;
    } else {
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
    }
    c.draw(f);
    const mode = blendModeFor(kind, f.light);
    // A glow composited straight is ink painted by the candidate itself, which takes no bloom.
    const bloom = mode === "normal" && c.mode === "glow" ? 0 : c.bloom;
    if (bloom > 0) bloomChain(T, dst, c.mode === "image" ? 0.55 : 0.0);
    composite(T, dst, mode, bloom, c, f);
  };

  const still = (kind: GlKind, f: Frame) => {
    if (!targets || gl.isContextLost()) return;
    // A fresh candidate, so the still frame never inherits trails from an earlier one.
    current?.candidate.dispose();
    current = null;
    const rolls = candidateFor(targets, kind).trail ? 40 : 1;
    for (let i = 0; i < rolls; i++) render(kind, { ...f, t: 14 + i / 60, dt: 1 / 60, still: true });
  };

  const dispose = () => {
    current?.candidate.dispose();
    current = null;
    freeTargets();
    kit.dispose();
    // Release the context now rather than at garbage collection, so remounts never pile up contexts.
    gl.getExtension("WEBGL_lose_context")?.loseContext();
  };

  return { fit, render, still, dispose };
}
