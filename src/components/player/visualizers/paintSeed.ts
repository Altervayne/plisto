/*
 * Paints a seed layout to a canvas: the theme ground, the blooms, then the Plisto logo centred over them.
 */

// -- Asset Imports --
import logoPlatinum from "../../../assets/plisto-logo-final.svg";
import logoSteel from "../../../assets/plisto-logo-steel.svg";

// -- Local Imports --
import type { SeedLayout } from "./coverSeed";

// Bloom opacity at strength 1, by theme: a light ground needs less to read.
const BASE_ALPHA_DARK = 0.69;
const BASE_ALPHA_LIGHT = 0.56;

// The logo's width as a share of the side.
const LOGO_SHARE = 0.7;

// Each logo is decoded once per session; a failed load is dropped so it retries.
const logos = new Map<boolean, Promise<HTMLImageElement>>();

function loadLogo(dark: boolean): Promise<HTMLImageElement> {
  let logo = logos.get(dark);
  if (!logo) {
    logo = new Promise<HTMLImageElement>((resolve, reject) => {
      const img = new Image();
      img.onload = () => resolve(img);
      img.onerror = () => reject(new Error("seed logo failed to load"));
      img.src = dark ? logoPlatinum : logoSteel;
    });
    logo.catch(() => logos.delete(dark));
    logos.set(dark, logo);
  }
  return logo;
}

/** Paints `layout` on a `side` square canvas for the dark or light theme. */
export async function paintSeed(layout: SeedLayout, dark: boolean, side: number): Promise<HTMLCanvasElement> {
  const logo = await loadLogo(dark);
  const canvas = document.createElement("canvas");
  canvas.width = canvas.height = side;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("seed canvas unavailable");
  ctx.fillStyle = getComputedStyle(document.documentElement).getPropertyValue("--surface").trim();
  ctx.fillRect(0, 0, side, side);
  const base = dark ? BASE_ALPHA_DARK : BASE_ALPHA_LIGHT;
  for (const { x, y, r, a, color } of layout.blooms) {
    const [cr, cg, cb] = color;
    const gradient = ctx.createRadialGradient(x * side, y * side, 0, x * side, y * side, side * r);
    gradient.addColorStop(0, `rgba(${cr},${cg},${cb},${Math.min(1, base * a)})`);
    gradient.addColorStop(1, `rgba(${cr},${cg},${cb},0)`);
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, side, side);
  }
  const w = side * LOGO_SHARE;
  const h = (w * logo.naturalHeight) / logo.naturalWidth;
  ctx.drawImage(logo, (side - w) / 2, (side - h) / 2, w, h);
  return canvas;
}
