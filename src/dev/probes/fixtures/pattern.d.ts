/*
 * Types of the API pattern.js assigns to globalThis, for the page's side-effect import of it.
 */

export interface PatternPatch {
  x: number;
  y: number;
  w: number;
  h: number;
  color: [number, number, number];
  alpha: number;
}

export interface ProbePatternApi {
  PATCH_PX: number;
  ALPHAS: number[];
  COLORS: [number, number, number][];
  patches(): PatternPatch[];
  size(): { width: number; height: number };
  drawWebGL(canvas: HTMLCanvasElement | OffscreenCanvas, scale: number): WebGL2RenderingContext | null;
  draw2D(canvas: HTMLCanvasElement | OffscreenCanvas, scale: number): CanvasRenderingContext2D | OffscreenCanvasRenderingContext2D | null;
}

declare global {
  var probePattern: ProbePatternApi;
}
