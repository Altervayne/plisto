/*
 * The cover-palette tone shared by the player aurora and the Browse glow: raw cover colours tempered
 * into a calm, theme-aware register, and a warm neutral tint standing in for a missing or near-gray
 * cover. Pure, so both surfaces read the same colours from the same palette.
 */

// -- Type Imports --
import type { Palette } from "./useCoverPalette";

export interface Rgb {
  r: number;
  g: number;
  b: number;
}

interface Hsl {
  h: number;
  s: number;
  l: number;
}

const SAT_CEILING = 0.58;
const SAT_FLOOR = 0.2;
const L_TARGET_LIGHT = 0.5;
const L_TARGET_DARK = 0.55;
// A barely-there warm tint standing in for a missing or near-gray cover, never pure gray.
const NEUTRAL_TINT: Hsl = { h: 35, s: 0.1, l: 0.58 };
const NOCOVER_OPACITY_FACTOR = 0.6;

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

export function mix(a: number, b: number, t: number): number {
  return a + (b - a) * t;
}

/** sRGB (0..255) to HSL with h in degrees, s and l in 0..1. */
function rgbToHsl({ r, g, b }: Rgb): Hsl {
  const rn = r / 255;
  const gn = g / 255;
  const bn = b / 255;
  const max = Math.max(rn, gn, bn);
  const min = Math.min(rn, gn, bn);
  const l = (max + min) / 2;
  const d = max - min;
  if (d === 0) return { h: 0, s: 0, l };
  const s = d / (1 - Math.abs(2 * l - 1));
  let h: number;
  if (max === rn) h = ((gn - bn) / d) % 6;
  else if (max === gn) h = (bn - rn) / d + 2;
  else h = (rn - gn) / d + 4;
  h *= 60;
  if (h < 0) h += 360;
  return { h, s, l };
}

/** HSL back to sRGB (0..255). */
function hslToRgb({ h, s, l }: Hsl): Rgb {
  const c = (1 - Math.abs(2 * l - 1)) * s;
  const hp = h / 60;
  const x = c * (1 - Math.abs((hp % 2) - 1));
  let r = 0;
  let g = 0;
  let b = 0;
  if (hp < 1) [r, g] = [c, x];
  else if (hp < 2) [r, g] = [x, c];
  else if (hp < 3) [g, b] = [c, x];
  else if (hp < 4) [g, b] = [x, c];
  else if (hp < 5) [r, b] = [x, c];
  else [r, b] = [c, x];
  const m = l - c / 2;
  return {
    r: Math.round((r + m) * 255),
    g: Math.round((g + m) * 255),
    b: Math.round((b + m) * 255),
  };
}

/**
 * Tempers a raw palette colour into the calm register: the hue stands, saturation is pulled into a
 * soft band, and lightness is drawn toward the theme's target so the field reads the same on either
 * ground. Hue and saturation are theme-independent; only lightness moves with the theme.
 */
export function temper(rgb: Rgb, isDark: boolean): Rgb {
  const { h, s, l } = rgbToHsl(rgb);
  const sat = clamp(s, SAT_FLOOR, SAT_CEILING);
  const target = isDark ? L_TARGET_DARK : L_TARGET_LIGHT;
  const light = clamp(mix(l, target, 0.6), 0.46, 0.66);
  return hslToRgb({ h, s: sat, l: light });
}

/** The tempered colour per bloom plus the layer-opacity factor for a given palette and theme. */
export interface PaletteTone {
  colors: Rgb[];
  opacityFactor: number;
}

/**
 * Derives `count` bloom colours for a palette: a null or near-gray palette paints the neutral tint on
 * every bloom and dims the layer; a palette with fewer colours than blooms reuses its last for the rest.
 */
export function derivePaletteTone(
  palette: Palette | null,
  isDark: boolean,
  count: number,
): PaletteTone {
  if (!palette || palette.length === 0) {
    const tint = hslToRgb(NEUTRAL_TINT);
    return {
      colors: Array.from({ length: count }, () => tint),
      opacityFactor: NOCOVER_OPACITY_FACTOR,
    };
  }
  const colors = Array.from({ length: count }, (_, i) => {
    const [r, g, b] = palette[Math.min(i, palette.length - 1)];
    return temper({ r, g, b }, isDark);
  });
  return { colors, opacityFactor: 1 };
}
