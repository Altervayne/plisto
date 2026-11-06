// -- Framework Imports --
import { useEffect, useRef } from "react";
import type { RefObject } from "react";

// -- State Imports --
import { getLatestLevel, getLatestSpectrum, smoothBands, foldToThirds } from "../../state/player/spectrum";
import { LEVEL_TAU, easeEnvelope } from "../../state/player/visualSignal";

// -- Utils Imports --
import { isDarkTheme } from "../../theme";
import { derivePaletteTone, mix } from "../covers/paletteTone";
import type { PaletteTone } from "../covers/paletteTone";

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
const AURORA_OPACITY_LIGHT = 0.22;
const AURORA_OPACITY_DARK = 0.5;
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

export function Aurora({
  trackId,
  coverRef,
  eased = false,
}: {
  trackId: number;
  // The now-playing cover, so the mask centers the field on the art. Absent, the mask stays centered
  // on the whole panel (the CSS default).
  coverRef?: RefObject<HTMLElement | null>;
  // Breathe on the level eased over about a second instead of the punchy band attack. The full-screen
  // ambient stage needs it: a stage-filling pulse on every beat is a flash.
  eased?: boolean;
}) {
  const easedRef = useRef(eased);
  easedRef.current = eased;
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
      from: PaletteTone,
      to: PaletteTone,
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
        const d = derivePaletteTone(paletteRef.current, isDark, BLOOMS.length);
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
    let easedLevel = 0;
    let driftTime = Math.PI; // a small offset so the blooms do not all start on a shared phase
    let from = derivePaletteTone(paletteRef.current, isDark, BLOOMS.length);
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
          to = derivePaletteTone(consumed, isDark, BLOOMS.length);
          if (crossfade >= 1) from = to;
        }
      }

      // A new palette (a track change, or the cover resolving) starts a crossfade from what is on
      // screen to the incoming colours.
      if (paletteRef.current !== consumed) {
        consumed = paletteRef.current;
        from = to;
        to = derivePaletteTone(consumed, isDark, BLOOMS.length);
        crossfade = 0;
      }

      // Bass-weighted breath from the folded spectrum, already eased by smoothBands' attack/decay so a
      // beat snaps up and settles. One stage - a second ease would flatten the pulse into a swell.
      smoothed = smoothBands(smoothed, getLatestSpectrum(), BREATH_ATTACK, BREATH_DECAY);
      const [low, mid, high] = foldToThirds(smoothed);
      easedLevel = easeEnvelope(easedLevel, getLatestLevel().rms, dt, LEVEL_TAU);
      const breath = easedRef.current ? easedLevel : 0.6 * low + 0.3 * mid + 0.1 * high;

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
