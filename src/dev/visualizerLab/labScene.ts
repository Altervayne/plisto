/*
 * The fixed scene the render lab draws every GL kind in: a procedural reference cover, its palette, the
 * Player and ambient layouts, the theme ground read from the tokens, and a seeded Math.random. Nothing
 * here varies between runs, so a render of the same kind is the same bytes every time.
 */

// -- Local Imports --
import type { Layout } from "../../components/player/visualizers/gl/renderer";
import type { Frame } from "../../components/player/visualizers/gl/kit";

// -- State Imports --
import { restSignal } from "../../state/player/visualSignal";

// -- Utils Imports --
import { paletteFloats } from "../../components/player/visualizers/visualizerPalette";

export type LabTheme = "light" | "dark";
export type LabLayoutId = "player" | "ambient";

/** The stage size of a layout, in CSS pixels. */
export interface LabLayout extends Layout {
  id: LabLayoutId;
}

/** The fixed time of a still frame. */
export const LAB_T = 14;

// The cover gradient's three colors, as the palette a real cover would yield.
const COVER_PALETTE: [number, number, number][] = [
  [224, 100, 79],
  [42, 138, 160],
  [246, 201, 138],
];

/** A tiny seeded generator. */
export function mulberry32(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const SEED = 0x9e3779b9;

/** Runs `body` with Math.random replaced by a fresh seeded stream, and restores it afterwards. */
export async function withSeededRandom<T>(body: () => Promise<T>): Promise<T> {
  const original = Math.random;
  Math.random = mulberry32(SEED);
  try {
    return await body();
  } finally {
    Math.random = original;
  }
}

/** Restarts the seeded stream, so each render starts from the same random state. */
export function reseed(): void {
  Math.random = mulberry32(SEED);
}

/** Pins the pixel ratio the renderer reads from the window. */
export function setDpr(dpr: number): void {
  Object.defineProperty(window, "devicePixelRatio", { value: dpr, configurable: true });
}

const PLAYER: LabLayout = {
  id: "player",
  width: 1000,
  height: 680,
  cover: [330, 90, 340, 340],
  radius: 16,
  // The hero column the visualizer feathers off outside.
  mask: [160, 40, 680, 480],
  floor: 600,
  hush: [
    [300, 450, 400, 28],
    [320, 484, 360, 20],
  ],
};

const AMBIENT: LabLayout = {
  id: "ambient",
  width: 1280,
  height: 800,
  cover: [470, 180, 340, 340],
  radius: 16,
  mask: null,
  floor: 730,
  hush: [
    [440, 560, 400, 32],
    [460, 600, 360, 22],
  ],
};

// The thumbnail stage: the ambient stage scaled to 680 x 424 (twice the 340 x 212 still), with the cover
// shrunk to 30% of the height around the ambient cover's centre, so the visualizer carries the picture.
const THUMB_SCALE = 680 / 1280;
const THUMB_COVER = 128;
export const THUMB_LAYOUT: LabLayout = {
  id: "ambient",
  width: 680,
  height: 424,
  cover: [
    Math.round((AMBIENT.cover[0] + AMBIENT.cover[2] / 2) * THUMB_SCALE - THUMB_COVER / 2),
    Math.round((AMBIENT.cover[1] + AMBIENT.cover[3] / 2) * THUMB_SCALE - THUMB_COVER / 2),
    THUMB_COVER,
    THUMB_COVER,
  ],
  radius: 10,
  mask: null,
  floor: AMBIENT.floor === null ? null : Math.round(AMBIENT.floor * THUMB_SCALE),
  hush: AMBIENT.hush.map(([x, y, w, h]): LabLayout["cover"] => [x * THUMB_SCALE, y * THUMB_SCALE, w * THUMB_SCALE, h * THUMB_SCALE]),
};

export const LAB_LAYOUTS: Record<LabLayoutId, LabLayout> = { player: PLAYER, ambient: AMBIENT };

/** Paints the reference cover, a sunset gradient with a sun disc, onto a square canvas. */
export function paintCover(size: number): HTMLCanvasElement {
  const c = document.createElement("canvas");
  c.width = size;
  c.height = size;
  const x = c.getContext("2d");
  if (!x) throw new Error("2d context unavailable");
  const s = size;
  const angle = (165 * Math.PI) / 180;
  const dir = [Math.sin(angle), -Math.cos(angle)];
  const half = ((Math.abs(dir[0]) + Math.abs(dir[1])) * s) / 2;
  const lin = x.createLinearGradient(s / 2 - dir[0] * half, s / 2 - dir[1] * half, s / 2 + dir[0] * half, s / 2 + dir[1] * half);
  lin.addColorStop(0, "#2a8aa0");
  lin.addColorStop(0.55, "#1b4560");
  lin.addColorStop(1, "#14283f");
  x.fillStyle = lin;
  x.fillRect(0, 0, s, s);
  const ellipse = (cx: number, cy: number, rx: number, ry: number, stops: [number, string][]) => {
    x.save();
    x.translate(cx * s, cy * s);
    x.scale(rx, ry);
    const g = x.createRadialGradient(0, 0, 0, 0, 0, s);
    for (const [o, col] of stops) g.addColorStop(o, col);
    x.fillStyle = g;
    x.fillRect(-s * 2, -s * 2, s * 4, s * 4);
    x.restore();
  };
  ellipse(0.78, 0.72, 0.7, 0.6, [[0, "rgba(224,100,79,1)"], [0.62, "rgba(224,100,79,0)"]]);
  ellipse(0.3, 0.22, 0.6, 0.5, [[0, "rgba(246,201,138,0.9)"], [0.6, "rgba(246,201,138,0)"]]);
  const sun = x.createRadialGradient(0.5 * s, 0.58 * s, 0, 0.5 * s, 0.58 * s, 0.7525 * s);
  sun.addColorStop(0, "#f9dba8");
  sun.addColorStop(0.11, "#f9dba8");
  sun.addColorStop(0.115, "rgba(249,219,168,0)");
  sun.addColorStop(1, "rgba(249,219,168,0)");
  x.fillStyle = sun;
  x.fillRect(0, 0, s, s);
  return c;
}

/** The reference cover as GL-ready pixels, flipped the way the app's cover reader flips them. */
export function coverPixels(): Promise<ImageBitmap> {
  return createImageBitmap(paintCover(512), { imageOrientation: "flipY" });
}

/** Reads a color token as sRGB in 0..1 under the current theme. */
function tokenRgb(token: string): [number, number, number] {
  const el = document.createElement("div");
  el.style.color = `var(${token})`;
  document.body.appendChild(el);
  const m = getComputedStyle(el).color.match(/[\d.]+/g);
  el.remove();
  return m && m.length >= 3 ? [Number(m[0]) / 255, Number(m[1]) / 255, Number(m[2]) / 255] : [0, 0, 0];
}

/** Stamps the theme on the document, the way the app does. */
export function applyTheme(theme: LabTheme): void {
  document.documentElement.dataset.theme = theme;
}

/** The theme's ground as an sRGB triple, for the layout: the base ground in ambient, the panel in the Player. */
export function groundOf(layout: LabLayoutId): [number, number, number] {
  return tokenRgb(layout === "ambient" ? "--bg" : "--surface");
}

/** The frame a still render takes: the rest signal, the reference cover and palette, and the theme grounds. */
export function labFrame(theme: LabTheme, layout: LabLayoutId, cover: ImageBitmap): Frame {
  return {
    t: LAB_T,
    dt: 1 / 60,
    sig: restSignal(),
    palette: paletteFloats(COVER_PALETTE),
    light: theme === "light",
    ambient: layout === "ambient",
    still: true,
    fine: null,
    cover,
    mirrored: false,
    backing: tokenRgb(theme === "light" ? "--surface-2" : "--sunken"),
    ground: groundOf(layout),
  };
}
