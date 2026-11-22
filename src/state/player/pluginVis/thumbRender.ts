/*
 * Renders one plugin kind's thumbnail: the kind's still on a stage like the ambient one, composed on the
 * theme's ground the way the slot blends it, with a plain cover tile, scaled to the tile size and encoded
 * as PNG. The theme is not the page's own, so the stage colors are the theme tokens' values written
 * out, the backing following the look the kind draws in that theme. A cover the kind asks for is left out.
 */

// -- Local Imports --
import { renderPluginStill } from "./stillMount";
import { defaultValues } from "./kindSettings";

// -- State Imports --
import { sceneLight } from "../visualizerKind";

// -- Type Imports --
import type { VisColors, VisContext, VisLayout, VisRgb } from "../../../visRuntime/protocol";
import type { PluginVisualizerDescriptor } from "../pluginVisualizers";
import type { ThumbTheme } from "./thumbs";

/** The thumbnail's size: the 170 px tile at 2x, as the built-in kinds' stills are. */
export const THUMB_W = 340;
export const THUMB_H = 212;
// The stage the kind draws on, at twice the thumbnail, with the cover tile small so the kind carries it.
const STAGE_W = THUMB_W * 2;
const STAGE_H = THUMB_H * 2;
const COVER = 128;
// The most the backend stores for one still.
const MAX_BYTES = 1024 * 1024;

const LAYOUT: VisLayout = {
  width: STAGE_W,
  height: STAGE_H,
  cover: [(STAGE_W - COVER) / 2, (STAGE_H - COVER) / 2 - 24, COVER, COVER],
  radius: 10,
  mask: null,
  floor: null,
  hush: [],
};

// A teal to navy cover palette: three sRGB colors, flattened.
const PALETTE = new Float32Array([0.17, 0.54, 0.63, 0.11, 0.27, 0.38, 0.08, 0.16, 0.25]);

const rgb = (hex: number): VisRgb => [(hex >> 16) / 255, ((hex >> 8) & 255) / 255, (hex & 255) / 255];
const byte = (v: number) => Math.round(v * 255);
const css = ([r, g, b]: VisRgb) => `rgb(${byte(r)} ${byte(g)} ${byte(b)})`;

// The ground, ink and the two backings of each theme, as styles/tokens.css gives them.
const TOKENS: Record<ThumbTheme, { ground: VisRgb; ink: VisRgb; surface2: VisRgb; sunken: VisRgb }> = {
  light: { ground: rgb(0xf4f4f8), ink: rgb(0x17171c), surface2: rgb(0xfafafc), sunken: rgb(0xeaeaf0) },
  dark: { ground: rgb(0x0c0c10), ink: rgb(0xf1f1f6), surface2: rgb(0x1c1c24), sunken: rgb(0x101015) },
};

// The stage colors as the live stage reads them: the backing is the light look's or the dark look's.
function colorsFor(theme: ThumbTheme, light: boolean): VisColors {
  const t = TOKENS[theme];
  return { ground: t.ground, backing: light ? t.surface2 : t.sunken, ink: t.ink };
}

export function contextFor(descriptor: PluginVisualizerDescriptor, theme: ThumbTheme): VisContext {
  const light = sceneLight(descriptor.id, theme === "light");
  return {
    layout: LAYOUT,
    palette: PALETTE,
    cover: null,
    colors: colorsFor(theme, light),
    light,
    reactivity: "balanced",
    ambient: true,
    reducedMotion: false,
    settings: defaultValues(descriptor.settings),
  };
}

const toBlob = (canvas: HTMLCanvasElement) =>
  new Promise<Blob | null>((resolve) => canvas.toBlob(resolve, "image/png"));

/** The kind's thumbnail in a theme as PNG bytes, or null when it gave no still or the image is too big. */
export async function renderThumbPng(
  descriptor: PluginVisualizerDescriptor,
  theme: ThumbTheme,
  signal?: AbortSignal,
): Promise<Uint8Array | null> {
  const context = contextFor(descriptor, theme);
  const mount = renderPluginStill(descriptor, context);
  signal?.addEventListener("abort", mount.cancel);
  if (signal?.aborted) mount.cancel();
  const outcome = await mount.result;
  signal?.removeEventListener("abort", mount.cancel);
  if (outcome.type !== "still") return null;
  const bitmap = outcome.bitmap;
  const canvas = document.createElement("canvas");
  canvas.width = THUMB_W;
  canvas.height = THUMB_H;
  const x = canvas.getContext("2d");
  if (!x) {
    bitmap.close();
    return null;
  }
  x.fillStyle = css(context.colors.ground);
  x.fillRect(0, 0, THUMB_W, THUMB_H);
  x.imageSmoothingQuality = "high";
  const blend = descriptor.look[context.light ? "light" : "dark"].blend;
  x.globalCompositeOperation = (blend === "normal" ? "source-over" : blend) as GlobalCompositeOperation;
  x.drawImage(bitmap, 0, 0, THUMB_W, THUMB_H);
  bitmap.close();
  x.globalCompositeOperation = "source-over";
  const [cx, cy, cw, ch] = LAYOUT.cover.map((v) => v / 2);
  const tile = x.createLinearGradient(cx, cy, cx + cw, cy + ch);
  tile.addColorStop(0, css([PALETTE[0], PALETTE[1], PALETTE[2]]));
  tile.addColorStop(1, css([PALETTE[6], PALETTE[7], PALETTE[8]]));
  x.fillStyle = tile;
  x.beginPath();
  x.roundRect(cx, cy, cw, ch, LAYOUT.radius / 2);
  x.fill();
  const blob = await toBlob(canvas);
  if (!blob || blob.size > MAX_BYTES) return null;
  return new Uint8Array(await blob.arrayBuffer());
}
