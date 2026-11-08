/*
 * The GL plumbing one visualizer surface owns: its program cache, uniform setters, render targets and
 * the full-screen triangle. Every candidate draws through this, so none touches context setup.
 */

// -- Local Imports --
import { HUSH_SLOTS } from "./shaders";

// -- Type Imports --
import type { VisualSignal } from "../../../../state/player/visualSignal";

/** A rect in GL pixels: left, bottom, width, height. */
export type Rect = [number, number, number, number];

/** Where the cover and the mask sit on the stage, in GL pixels. */
export interface Geometry {
  cover: Rect;
  radius: number;
  // The rect the layer feathers off outside; null draws the whole stage.
  mask: Rect | null;
  // The height of the element the layer rests on, such as the seek bar's top edge; null for none.
  floor: number | null;
  // The text blocks a visualizer may hush behind, up to HUSH_SLOTS of them.
  hush: Rect[];
}

/** One frame's inputs. */
export interface Frame {
  t: number;
  dt: number;
  sig: VisualSignal;
  // Three sRGB colors in 0..1, flattened.
  palette: Float32Array;
  light: boolean;
  ambient: boolean;
  still: boolean;
  // The smoothed 128-band spectrum, or null to fall back on the 24 bands.
  fine: number[] | null;
  // The cover's pixels, flipped for GL, or null when there are none.
  cover: ImageBitmap | null;
  // The dot spectrum lays its columns out from the centre rather than from the left.
  mirrored: boolean;
  // The ground under a cover-sized dot matrix, as sRGB in 0..1: paper on light, near-black on dark.
  backing: [number, number, number];
  // The stage's own ground as sRGB in 0..1: the panel's surface in the Player, the base ground in ambient.
  ground: [number, number, number];
  // The track position over its duration in 0..1, or null when unknown.
  progress?: number | null;
}

/** The feedback a trail candidate applies to the previous frame. */
export interface Trail {
  decay: number;
  zoom: number;
  rot: number;
}

/** One visualizer's look and draw. */
export interface Candidate {
  // A glow is light that maps to screen or multiply by theme; an image paints real color.
  mode: "glow" | "image";
  bloom: number;
  exposure: number;
  // The extra exposure ink needs on a light ground to read at the weight of light on a dark one.
  inkGain: number;
  trail: Trail | null;
  draw: (frame: Frame) => void;
  trailCenter?: () => [number, number];
  trailZoom?: (frame: Frame) => number;
  trailDecay?: (frame: Frame) => number;
  // The corner darkening ambient applies, 0..1; absent, the stage default.
  vignette?: number;
  dispose: () => void;
}

export interface Program {
  handle: WebGLProgram;
  loc: Map<string, WebGLUniformLocation | null>;
}

export interface Target {
  tex: WebGLTexture;
  fbo: WebGLFramebuffer;
  w: number;
  h: number;
}

export interface Kit {
  gl: WebGL2RenderingContext;
  // The backing size in device pixels and the pixel ratio, kept current by the renderer's fit.
  size: { w: number; h: number; dpr: number };
  geo: Geometry;
  program: (name: string, vs: string, fs: string) => Program;
  uniform: (p: Program, name: string) => WebGLUniformLocation | null;
  set1: (p: Program, name: string, v: number) => void;
  set2: (p: Program, name: string, a: number, b: number) => void;
  set4: (p: Program, name: string, v: Rect) => void;
  seti: (p: Program, name: string, v: number) => void;
  bindTex: (p: Program, name: string, unit: number, tex: WebGLTexture) => void;
  setCommon: (p: Program, frame: Frame) => void;
  drawQuad: () => void;
  makeTarget: (w: number, h: number) => Target;
  freeTarget: (t: Target) => void;
  bindTarget: (t: Target | null) => void;
  // The target last bound, so a candidate that draws into its own buffers can return to the scene.
  boundTarget: () => Target | null;
  dispose: () => void;
}

// The hush's falloff width around a text block, in CSS pixels.
const HUSH_FEATHER = 110;

/** Builds the kit over a fresh context. Throws on a shader that fails to compile or link. */
export function createKit(gl: WebGL2RenderingContext): Kit {
  const floatOk = gl.getExtension("EXT_color_buffer_float") != null;
  const programs = new Map<string, Program>();
  const size = { w: 1, h: 1, dpr: 1 };
  const geo: Geometry = { cover: [0, 0, 1, 1], radius: 16, mask: null, floor: null, hush: [] };
  const hush = new Float32Array(HUSH_SLOTS * 4);

  const quad = gl.createVertexArray();
  const quadVbo = gl.createBuffer();
  gl.bindVertexArray(quad);
  gl.bindBuffer(gl.ARRAY_BUFFER, quadVbo);
  gl.bufferData(gl.ARRAY_BUFFER, new Float32Array([-1, -1, 3, -1, -1, 3]), gl.STATIC_DRAW);
  gl.enableVertexAttribArray(0);
  gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
  gl.bindVertexArray(null);

  const compile = (vsSrc: string, fsSrc: string): WebGLProgram => {
    const make = (type: number, src: string) => {
      const s = gl.createShader(type);
      if (!s) throw new Error("shader allocation failed");
      gl.shaderSource(s, src);
      gl.compileShader(s);
      if (!gl.getShaderParameter(s, gl.COMPILE_STATUS)) throw new Error(gl.getShaderInfoLog(s) ?? "shader compile failed");
      return s;
    };
    const p = gl.createProgram();
    if (!p) throw new Error("program allocation failed");
    const vs = make(gl.VERTEX_SHADER, vsSrc);
    const fs = make(gl.FRAGMENT_SHADER, fsSrc);
    gl.attachShader(p, vs);
    gl.attachShader(p, fs);
    gl.linkProgram(p);
    gl.deleteShader(vs);
    gl.deleteShader(fs);
    if (!gl.getProgramParameter(p, gl.LINK_STATUS)) throw new Error(gl.getProgramInfoLog(p) ?? "program link failed");
    return p;
  };

  const program = (name: string, vs: string, fs: string): Program => {
    let p = programs.get(name);
    if (!p) {
      p = { handle: compile(vs, fs), loc: new Map() };
      programs.set(name, p);
    }
    return p;
  };

  const uniform = (p: Program, name: string) => {
    if (!p.loc.has(name)) p.loc.set(name, gl.getUniformLocation(p.handle, name));
    return p.loc.get(name) ?? null;
  };
  const set1 = (p: Program, name: string, v: number) => {
    const l = uniform(p, name);
    if (l) gl.uniform1f(l, v);
  };
  const set2 = (p: Program, name: string, a: number, b: number) => {
    const l = uniform(p, name);
    if (l) gl.uniform2f(l, a, b);
  };
  const set4 = (p: Program, name: string, v: Rect) => {
    const l = uniform(p, name);
    if (l) gl.uniform4f(l, v[0], v[1], v[2], v[3]);
  };
  const seti = (p: Program, name: string, v: number) => {
    const l = uniform(p, name);
    if (l) gl.uniform1i(l, v);
  };
  const bindTex = (p: Program, name: string, unit: number, tex: WebGLTexture) => {
    gl.activeTexture(gl.TEXTURE0 + unit);
    gl.bindTexture(gl.TEXTURE_2D, tex);
    seti(p, name, unit);
  };

  const setCommon = (p: Program, f: Frame) => {
    gl.useProgram(p.handle);
    const s = f.sig;
    set2(p, "uRes", size.w, size.h);
    set1(p, "uTime", f.t);
    set1(p, "uDpr", size.dpr);
    const lb = uniform(p, "uBands");
    if (lb) gl.uniform1fv(lb, s.bands);
    // uRms carries the eased level: the one value allowed to drive brightness.
    set1(p, "uRms", s.level);
    set1(p, "uPeak", s.peak);
    set1(p, "uFlux", s.flux);
    set1(p, "uKick", s.kick);
    set1(p, "uBass", s.bass);
    set1(p, "uMid", s.mid);
    set1(p, "uHigh", s.high);
    const lp = uniform(p, "uPal");
    if (lp) gl.uniform3fv(lp, f.palette);
    set4(p, "uCover", geo.cover);
    set1(p, "uRadius", geo.radius);
    set1(p, "uAmbient", f.ambient ? 1 : 0);
    const lh = uniform(p, "uHush");
    if (lh) {
      hush.fill(0);
      geo.hush.slice(0, HUSH_SLOTS).forEach((r, i) => hush.set(r, i * 4));
      gl.uniform4fv(lh, hush);
      set1(p, "uHushFeather", HUSH_FEATHER * size.dpr);
    }
  };

  const drawQuad = () => {
    gl.bindVertexArray(quad);
    gl.drawArrays(gl.TRIANGLES, 0, 3);
  };

  const makeTarget = (w: number, h: number): Target => {
    const tex = gl.createTexture();
    const fbo = gl.createFramebuffer();
    if (!tex || !fbo) throw new Error("target allocation failed");
    gl.bindTexture(gl.TEXTURE_2D, tex);
    if (floatOk) gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA16F, w, h, 0, gl.RGBA, gl.HALF_FLOAT, null);
    else gl.texImage2D(gl.TEXTURE_2D, 0, gl.RGBA8, w, h, 0, gl.RGBA, gl.UNSIGNED_BYTE, null);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.LINEAR);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_S, gl.CLAMP_TO_EDGE);
    gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_WRAP_T, gl.CLAMP_TO_EDGE);
    gl.bindFramebuffer(gl.FRAMEBUFFER, fbo);
    gl.framebufferTexture2D(gl.FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.TEXTURE_2D, tex, 0);
    gl.clearColor(0, 0, 0, 0);
    gl.clear(gl.COLOR_BUFFER_BIT);
    return { tex, fbo, w, h };
  };

  const freeTarget = (t: Target) => {
    gl.deleteTexture(t.tex);
    gl.deleteFramebuffer(t.fbo);
  };

  let bound: Target | null = null;
  const bindTarget = (t: Target | null) => {
    bound = t;
    gl.bindFramebuffer(gl.FRAMEBUFFER, t ? t.fbo : null);
    gl.viewport(0, 0, t ? t.w : size.w, t ? t.h : size.h);
  };

  const dispose = () => {
    for (const p of programs.values()) gl.deleteProgram(p.handle);
    programs.clear();
    gl.deleteVertexArray(quad);
    gl.deleteBuffer(quadVbo);
  };

  return {
    gl,
    size,
    geo,
    program,
    uniform,
    set1,
    set2,
    set4,
    seti,
    bindTex,
    setCommon,
    drawQuad,
    makeTarget,
    freeTarget,
    bindTarget,
    boundTarget: () => bound,
    dispose,
  };
}
