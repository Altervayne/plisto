/*
 * The soft color bloom the slot blends over, standing in for the app's own backdrop: the stage ground with
 * three slow blobs in the cover's palette that breathe with the level. It only needs to give a screen,
 * multiply or normal blend something to mix with; it does not match Plisto's own aurora.
 */

// -- Local Imports --
import { THEMES } from "./context.js";

const BLOBS = [
  { x: 0.28, y: 0.35, r: 0.5, speed: 0.11, phase: 0 },
  { x: 0.7, y: 0.4, r: 0.45, speed: 0.08, phase: 2.1 },
  { x: 0.5, y: 0.78, r: 0.55, speed: 0.06, phase: 4.2 },
];

const channel = (v) => Math.round(v * 255);
const css = (rgb, a) => `rgba(${channel(rgb[0])}, ${channel(rgb[1])}, ${channel(rgb[2])}, ${a})`;

/** Paints one frame of the backdrop at `t` seconds; `level` (0..1) swells the blobs a little. */
export function paintBackdrop(canvas, { theme, palette, t, level }) {
  const g = canvas.getContext("2d");
  const { width, height } = canvas;
  g.fillStyle = css(THEMES[theme].ground, 1);
  g.fillRect(0, 0, width, height);
  const alpha = theme === "light" ? 0.4 : 0.55;
  BLOBS.forEach((blob, i) => {
    const angle = t * blob.speed + blob.phase;
    const cx = (blob.x + 0.08 * Math.cos(angle)) * width;
    const cy = (blob.y + 0.08 * Math.sin(angle * 1.3)) * height;
    const radius = blob.r * Math.max(width, height) * (0.8 + 0.2 * level);
    const color = palette.slice(i * 3, i * 3 + 3);
    const grad = g.createRadialGradient(cx, cy, 0, cx, cy, radius);
    grad.addColorStop(0, css(color, alpha));
    grad.addColorStop(1, css(color, 0));
    g.fillStyle = grad;
    g.fillRect(0, 0, width, height);
  });
}
