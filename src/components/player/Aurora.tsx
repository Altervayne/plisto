// -- Framework Imports --
import { useEffect, useRef } from "react";
import type { RefObject } from "react";

// -- State Imports --
import { getLatestSpectrum, smoothBands, foldToThirds } from "../../state/player/spectrum";

// -- Hook Imports --
import { useCoverPalette, type Palette } from "../covers/useCoverPalette";

// -- Type Imports --
import { BAND_COUNT } from "../../types";

// -- Style Imports --
import styles from "./Aurora.module.css";

/*
 * Ambient aurora behind the full player: three soft colour blooms drawn from the cover's dominant
 * palette, drifting on slow non-harmonic sines and breathing with the low end of the spectrum. The
 * field paints on a tiny fixed backing canvas and the CSS blur upscales it, so the smoothing is free
 * and never bands. Off-React on its own frame like the ridge; aria-hidden, no accent, no chrome.
 *
 * -- Tunables (first-pass; grouped so they are easy to dial) --
 */
const AURORA_DRIFT_SCALE = 5.0;
// Base-amplitude multiplier: the blooms travel further so the wander actually reads against the heavy
// blur, where a small centre shift of a large soft bloom is invisible.
const AURORA_DRIFT_AMP = 1.8;
const AURORA_BREATH_SCALE = 0.35;
const AURORA_BREATH_LIFT = 0.35;
// Punchy attack, eased decay - the breath snaps up on a hit and settles, so a beat reads as a pulse
// rather than a slow swell. One smoothing stage (this), not two, or the beat washes out.
const BREATH_ATTACK = 0.45;
const BREATH_DECAY = 0.12;
const AURORA_SAT_CEILING = 0.58;
const AURORA_SAT_FLOOR = 0.2;
const AURORA_L_TARGET_LIGHT = 0.5;
const AURORA_L_TARGET_DARK = 0.55;
const AURORA_OPACITY_LIGHT = 0.22;
const AURORA_OPACITY_DARK = 0.5;
// A barely-there warm tint standing in for a missing or near-gray cover, never pure gray.
const AURORA_NEUTRAL_TINT: Hsl = { h: 35, s: 0.1, l: 0.58 };
const AURORA_NOCOVER_OPACITY_FACTOR = 0.6;
const AURORA_BLUR_PX = 48;
const AURORA_CROSSFADE_MS = 1400;
const AURORA_FPS = 30;
// Energy also nudges the drift a hair faster; kept tiny so the wander stays a wander.
const AURORA_BREATH_DRIFT = 0.1;
// The feather mask centers on the cover with this radius, as a multiple of the cover width - large
// enough that the glow reads as a broad halo around the art, still falling off before the queue.
const AURORA_MASK_SPAN = 2.3;
// Per-bloom core alpha before the layer opacity and blur take over. Blooms add under "lighter", so
// this stays well below 1 to keep overlaps from clipping to white.
const BLOOM_CORE_ALPHA = 0.7;

// The backing canvas the field draws on. Small on purpose: the blur upscales it, so a big canvas
// would only cost fill for no visible gain.
const BACK_W = 480;
const BACK_H = 270;

interface Rgb {
  r: number;
  g: number;
  b: number;
}

interface Hsl {
  h: number;
  s: number;
  l: number;
}

/*
 * The three blooms. Centres and radii are fractions of the backing width, large so they overlap into
 * one field. Each centre rides a slow sine on x and y at its own period and phase; blooms 1 and 2
 * carry opposite-sign x phase so the field scissors rather than sliding as a block. Periods are
 * mutually non-harmonic so the loop never visibly repeats.
 */
interface Bloom {
  cx: number;
  cy: number;
  radius: number;
  periodX: number;
  periodY: number;
  ampX: number;
  ampY: number;
  phaseX: number;
  phaseY: number;
  pulsePeriod: number;
  pulseAmt: number;
  pulsePhase: number;
}

const BLOOMS: Bloom[] = [
  {
    cx: 0.32,
    cy: 0.38,
    radius: 0.62,
    periodX: 68,
    periodY: 86.4,
    ampX: 0.08,
    ampY: 0.06,
    phaseX: 0.6,
    phaseY: 1.3,
    pulsePeriod: 44,
    pulseAmt: 0.04,
    pulsePhase: 0,
  },
  {
    cx: 0.7,
    cy: 0.64,
    radius: 0.54,
    periodX: 82,
    periodY: 68.1,
    ampX: 0.07,
    ampY: 0.09,
    phaseX: -0.6,
    phaseY: 2.9,
    pulsePeriod: 52,
    pulseAmt: 0.04,
    pulsePhase: 1.4,
  },
  {
    cx: 0.52,
    cy: 0.82,
    radius: 0.44,
    periodX: 56,
    periodY: 66.6,
    ampX: 0.1,
    ampY: 0.05,
    phaseX: 2.1,
    phaseY: 0.4,
    pulsePeriod: 60,
    pulseAmt: 0.03,
    pulsePhase: 2.7,
  },
];

function clamp(v: number, lo: number, hi: number): number {
  return v < lo ? lo : v > hi ? hi : v;
}

function mix(a: number, b: number, t: number): number {
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
 * Tempers a raw palette colour into the aurora's calm register: the hue stands, saturation is pulled
 * into a soft band, and lightness is drawn toward the theme's target so the field reads the same on
 * either ground. Hue and saturation are theme-independent; only lightness moves with the theme.
 */
function temper(rgb: Rgb, isDark: boolean): Rgb {
  const { h, s, l } = rgbToHsl(rgb);
  const sat = clamp(s, AURORA_SAT_FLOOR, AURORA_SAT_CEILING);
  const target = isDark ? AURORA_L_TARGET_DARK : AURORA_L_TARGET_LIGHT;
  const light = clamp(mix(l, target, 0.6), 0.46, 0.66);
  return hslToRgb({ h, s: sat, l: light });
}

/** The tempered colour per bloom plus the layer-opacity factor for a given palette and theme. */
interface Derived {
  colors: Rgb[];
  opacityFactor: number;
}

/**
 * Derives the three bloom colours for a palette: a null or near-gray palette paints the neutral tint
 * on all three and dims the layer; a palette with fewer colours than blooms reuses its dominant for
 * the rest.
 */
function derive(palette: Palette | null, isDark: boolean): Derived {
  if (!palette || palette.length === 0) {
    const tint = hslToRgb(AURORA_NEUTRAL_TINT);
    return {
      colors: BLOOMS.map(() => tint),
      opacityFactor: AURORA_NOCOVER_OPACITY_FACTOR,
    };
  }
  const colors = BLOOMS.map((_, i) => {
    const [r, g, b] = palette[Math.min(i, palette.length - 1)];
    return temper({ r, g, b }, isDark);
  });
  return { colors, opacityFactor: 1 };
}

/** The effective theme: an explicit stamp wins, else the system scheme. */
function isDarkTheme(): boolean {
  const stamp = document.documentElement.dataset.theme;
  if (stamp === "dark") return true;
  if (stamp === "light") return false;
  return window.matchMedia("(prefers-color-scheme: dark)").matches;
}

export function Aurora({
  trackId,
  coverRef,
}: {
  trackId: number;
  // The now-playing cover, so the mask centers the field on the art. Absent, the mask stays centered
  // on the whole panel (the CSS default).
  coverRef?: RefObject<HTMLElement | null>;
}) {
  const palette = useCoverPalette(trackId);
  const paletteRef = useRef<Palette | null>(palette);
  paletteRef.current = palette;
  // Reduced motion has no loop; this holds its repaint so a palette change can trigger one.
  const repaintRef = useRef<(() => void) | null>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);

  // Center the feather mask on the cover, re-measured whenever a resize moves it. Independent of the
  // paint loop, so it holds under reduced motion too. Without a cover ref the CSS default (panel
  // center) stands.
  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const layout = () => {
      const cover = coverRef?.current;
      if (!cover) return;
      const cv = canvas.getBoundingClientRect();
      const cr = cover.getBoundingClientRect();
      if (cr.width === 0) return;
      const r = cr.width * AURORA_MASK_SPAN;
      canvas.style.setProperty("--aurora-mx", `${cr.left - cv.left + cr.width / 2}px`);
      canvas.style.setProperty("--aurora-my", `${cr.top - cv.top + cr.height / 2}px`);
      canvas.style.setProperty("--aurora-rx", `${r}px`);
      canvas.style.setProperty("--aurora-ry", `${r}px`);
    };
    layout();
    const ro = new ResizeObserver(layout);
    ro.observe(canvas);
    if (coverRef?.current) ro.observe(coverRef.current);
    return () => ro.disconnect();
  }, [coverRef]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;
    canvas.width = BACK_W;
    canvas.height = BACK_H;
    canvas.style.filter = `blur(${AURORA_BLUR_PX}px)`;

    let isDark = isDarkTheme();

    // Paints the field at a given drift time, energy and crossfade mix, then sets the layer's blend
    // and opacity. The blooms add under "lighter" so they build one continuous wash.
    const paint = (
      driftTime: number,
      energy: number,
      from: Derived,
      to: Derived,
      crossfade: number,
    ) => {
      ctx.globalCompositeOperation = "source-over";
      ctx.clearRect(0, 0, BACK_W, BACK_H);
      ctx.globalCompositeOperation = "lighter";

      BLOOMS.forEach((bloom, i) => {
        const cx =
          (bloom.cx +
            Math.sin((driftTime / bloom.periodX) * Math.PI * 2 + bloom.phaseX) *
              bloom.ampX *
              AURORA_DRIFT_AMP) *
          BACK_W;
        const cy =
          (bloom.cy +
            Math.sin((driftTime / bloom.periodY) * Math.PI * 2 + bloom.phaseY) *
              bloom.ampY *
              AURORA_DRIFT_AMP) *
          BACK_H;
        const pulse = 1 + bloom.pulseAmt * Math.sin((driftTime / bloom.pulsePeriod) * Math.PI * 2 + bloom.pulsePhase);
        const radius = bloom.radius * BACK_W * pulse * (1 + AURORA_BREATH_SCALE * energy);

        const c = {
          r: Math.round(mix(from.colors[i].r, to.colors[i].r, crossfade)),
          g: Math.round(mix(from.colors[i].g, to.colors[i].g, crossfade)),
          b: Math.round(mix(from.colors[i].b, to.colors[i].b, crossfade)),
        };
        const grad = ctx.createRadialGradient(cx, cy, 0, cx, cy, radius);
        grad.addColorStop(0, `rgba(${c.r}, ${c.g}, ${c.b}, ${BLOOM_CORE_ALPHA})`);
        grad.addColorStop(0.5, `rgba(${c.r}, ${c.g}, ${c.b}, ${BLOOM_CORE_ALPHA * 0.5})`);
        grad.addColorStop(1, `rgba(${c.r}, ${c.g}, ${c.b}, 0)`);
        ctx.fillStyle = grad;
        ctx.fillRect(0, 0, BACK_W, BACK_H);
      });

      canvas.style.mixBlendMode = isDark ? "screen" : "normal";
      const base = isDark ? AURORA_OPACITY_DARK : AURORA_OPACITY_LIGHT;
      const factor = mix(from.opacityFactor, to.opacityFactor, crossfade);
      canvas.style.opacity = String((base + AURORA_BREATH_LIFT * energy) * factor);
    };

    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      // One still frame: base composition, base radii, no breath. Repaint only on the seams.
      const still = () => {
        isDark = isDarkTheme();
        const d = derive(paletteRef.current, isDark);
        paint(0, 0, d, d, 1);
      };
      repaintRef.current = still;
      still();

      const ro = new ResizeObserver(() => still());
      ro.observe(canvas);
      const root = document.documentElement;
      const themeObs = new MutationObserver(() => still());
      themeObs.observe(root, { attributes: true, attributeFilter: ["data-theme"] });
      const media = window.matchMedia("(prefers-color-scheme: dark)");
      media.addEventListener("change", still);

      return () => {
        repaintRef.current = null;
        ro.disconnect();
        themeObs.disconnect();
        media.removeEventListener("change", still);
      };
    }

    let smoothed: number[] = new Array(BAND_COUNT).fill(0);
    let driftTime = Math.PI; // a small offset so the blooms do not all start on a shared phase
    let from = derive(paletteRef.current, isDark);
    let to = from;
    let crossfade = 1;
    let consumed = paletteRef.current;

    let tick = 0;
    let raf = 0;
    let lastDraw = performance.now();
    const frameInterval = 1000 / AURORA_FPS;

    const frame = (now: number) => {
      raf = requestAnimationFrame(frame);
      if (now - lastDraw < frameInterval) return;
      const dt = (now - lastDraw) / 1000;
      lastDraw = now;

      // Re-read the theme now and then so a swap retints without a matchMedia every frame.
      if (tick++ % 30 === 0) {
        const nextDark = isDarkTheme();
        if (nextDark !== isDark) {
          isDark = nextDark;
          to = derive(consumed, isDark);
          if (crossfade >= 1) from = to;
        }
      }

      // A new palette (a track change, or the cover resolving) starts a crossfade from what is on
      // screen to the incoming colours.
      if (paletteRef.current !== consumed) {
        consumed = paletteRef.current;
        from = to;
        to = derive(consumed, isDark);
        crossfade = 0;
      }

      // Bass-weighted breath from the folded spectrum, already eased by smoothBands' attack/decay so a
      // beat snaps up and settles. One stage - a second ease would flatten the pulse into a swell.
      smoothed = smoothBands(smoothed, getLatestSpectrum(), BREATH_ATTACK, BREATH_DECAY);
      const [low, mid, high] = foldToThirds(smoothed);
      const breath = 0.6 * low + 0.3 * mid + 0.1 * high;

      driftTime += dt * AURORA_DRIFT_SCALE * (1 + AURORA_BREATH_DRIFT * breath);
      if (crossfade < 1) crossfade = Math.min(1, crossfade + (dt * 1000) / AURORA_CROSSFADE_MS);

      paint(driftTime, breath, from, to, crossfade);
    };
    raf = requestAnimationFrame(frame);

    return () => cancelAnimationFrame(raf);
  }, []);

  // Reduced motion repaints its still frame when the palette changes; a no-op while animating.
  useEffect(() => {
    repaintRef.current?.();
  }, [palette]);

  return <canvas ref={canvasRef} className={styles.aurora} aria-hidden="true" />;
}
