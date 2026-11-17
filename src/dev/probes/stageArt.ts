/*
 * The fixed artwork behind the stage replica: a generated cover for the glow and a static aurora field.
 * Both are painted once with fixed values, so two stages built from them capture identically.
 */

import type { Theme } from "./types";

// The aurora's backing store and presentation, as the player draws it.
export const AURORA_BACK_W = 480;
export const AURORA_BACK_H = 270;
export const AURORA_BLUR_PX = 48;
export const AURORA_OPACITY: Record<Theme, number> = { dark: 0.5, light: 0.22 };

const COVER_PX = 128;

// Cover quadrants and bloom centers: warm, cool and neutral washes at fixed positions.
const COVER_COLORS = ["#e0644f", "#2a8aa0", "#f6c98a", "#5b4a8a"];
const BLOOMS: { cx: number; cy: number; r: number; rgb: string }[] = [
  { cx: 0.32, cy: 0.38, r: 0.62, rgb: "224,100,79" },
  { cx: 0.7, cy: 0.64, r: 0.55, rgb: "42,138,160" },
  { cx: 0.5, cy: 0.9, r: 0.5, rgb: "246,201,138" },
];

/** A data URL of a small four-color cover, for the glow's background. */
export function coverFixtureUrl(): string {
  const canvas = document.createElement("canvas");
  canvas.width = COVER_PX;
  canvas.height = COVER_PX;
  const ctx = canvas.getContext("2d");
  if (!ctx) return "";
  const half = COVER_PX / 2;
  COVER_COLORS.forEach((color, i) => {
    ctx.fillStyle = color;
    ctx.fillRect((i % 2) * half, Math.floor(i / 2) * half, half, half);
  });
  return canvas.toDataURL("image/png");
}

/** Paints the static aurora field onto `canvas`, sized to the backing store. */
export function paintAurora(canvas: HTMLCanvasElement): void {
  canvas.width = AURORA_BACK_W;
  canvas.height = AURORA_BACK_H;
  const ctx = canvas.getContext("2d");
  if (!ctx) return;
  ctx.clearRect(0, 0, AURORA_BACK_W, AURORA_BACK_H);
  ctx.globalCompositeOperation = "lighter";
  for (const bloom of BLOOMS) {
    const cx = bloom.cx * AURORA_BACK_W;
    const cy = bloom.cy * AURORA_BACK_H;
    const grad = ctx.createRadialGradient(cx, cy, 0, cx, cy, bloom.r * AURORA_BACK_W);
    grad.addColorStop(0, `rgba(${bloom.rgb}, 0.7)`);
    grad.addColorStop(0.5, `rgba(${bloom.rgb}, 0.35)`);
    grad.addColorStop(1, `rgba(${bloom.rgb}, 0)`);
    ctx.fillStyle = grad;
    ctx.fillRect(0, 0, AURORA_BACK_W, AURORA_BACK_H);
  }
}
