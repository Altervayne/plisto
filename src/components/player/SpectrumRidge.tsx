// -- Framework Imports --
import { useEffect, useRef } from "react";

// -- State Imports --
import { getLatestSpectrum, smoothBands } from "../../state/player/spectrum";

// -- Type Imports --
import { BAND_COUNT } from "../../types";

// -- Style Imports --
import styles from "./SpectrumRidge.module.css";

// Fast-attack, slow-decay ballistics: the ridge snaps up on a hit and eases back down, and interpolates
// between the engine's ~30fps emits so it stays smooth at the display refresh.
const ATTACK = 0.5;
const DECAY = 0.15;

// The silhouette rises to this fraction of the canvas height at a full band, leaving a little headroom.
const MAX_AMP = 0.82;

// The base fill alpha at the floor, easing to nothing near the top so the ridge melts into the ground.
const BASE_ALPHA = 0.5;
const MID_ALPHA = 0.16;

interface Ink {
  r: number;
  g: number;
  b: number;
}

/** Reads the element's resolved ink color, so the fill follows the theme. Falls back to the light ink. */
function readInk(el: HTMLElement): Ink {
  const parts = getComputedStyle(el).color.match(/(\d+(?:\.\d+)?)/g);
  if (!parts || parts.length < 3) return { r: 23, g: 23, b: 28 };
  return { r: Number(parts[0]), g: Number(parts[1]), b: Number(parts[2]) };
}

/** A calm shallow arch, tallest in the middle: the resting silhouette drawn under a reduced-motion preference. */
function restingBands(): number[] {
  return Array.from({ length: BAND_COUNT }, (_, i) => {
    const t = i / (BAND_COUNT - 1);
    return 0.06 + 0.1 * Math.sin(Math.PI * t);
  });
}

/**
 * The audio-reactive horizon behind the player: a filled, continuous silhouette that rises from the view
 * floor with the music. It polls the spectrum singleton on its own animation frame and keeps its own
 * smoothing, so the ~30fps feed never touches React. Purely ambient - aria-hidden, no accent, low contrast.
 * Under a reduced-motion preference it draws one still resting curve and runs no loop.
 */
export function SpectrumRidge() {
  const canvasRef = useRef<HTMLCanvasElement>(null);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    const ctx = canvas.getContext("2d");
    if (!ctx) return;

    let width = 0;
    let height = 0;

    // Size the backing store to the device pixels so the curve stays crisp, then draw in CSS pixels.
    const fit = () => {
      const rect = canvas.getBoundingClientRect();
      const dpr = window.devicePixelRatio || 1;
      width = rect.width;
      height = rect.height;
      canvas.width = Math.max(1, Math.round(rect.width * dpr));
      canvas.height = Math.max(1, Math.round(rect.height * dpr));
      ctx.setTransform(dpr, 0, 0, dpr, 0, 0);
    };
    fit();

    let ink = readInk(canvas);

    // Paints one filled silhouette: a smooth curve through the bands closed down to the floor. The points
    // are joined by quadratic midpoints so the ridge reads as a continuous horizon, not stepped bars.
    const draw = (bands: number[]) => {
      ctx.clearRect(0, 0, width, height);
      const last = bands.length - 1;
      if (last < 1) return;

      const xAt = (i: number) => (i / last) * width;
      const yAt = (v: number) => height - Math.min(1, Math.max(0, v)) * height * MAX_AMP;

      ctx.beginPath();
      ctx.moveTo(0, height);
      ctx.lineTo(0, yAt(bands[0]));
      for (let i = 0; i < last; i++) {
        const mx = (xAt(i) + xAt(i + 1)) / 2;
        const my = (yAt(bands[i]) + yAt(bands[i + 1])) / 2;
        ctx.quadraticCurveTo(xAt(i), yAt(bands[i]), mx, my);
      }
      ctx.lineTo(xAt(last), yAt(bands[last]));
      ctx.lineTo(width, height);
      ctx.closePath();

      const grad = ctx.createLinearGradient(0, height, 0, 0);
      grad.addColorStop(0, `rgba(${ink.r}, ${ink.g}, ${ink.b}, ${BASE_ALPHA})`);
      grad.addColorStop(0.55, `rgba(${ink.r}, ${ink.g}, ${ink.b}, ${MID_ALPHA})`);
      grad.addColorStop(1, `rgba(${ink.r}, ${ink.g}, ${ink.b}, 0)`);
      ctx.fillStyle = grad;
      ctx.fill();
    };

    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      const rest = restingBands();
      draw(rest);
      const ro = new ResizeObserver(() => {
        fit();
        ink = readInk(canvas);
        draw(rest);
      });
      ro.observe(canvas);
      return () => ro.disconnect();
    }

    let smoothed: number[] = new Array(BAND_COUNT).fill(0);
    let tick = 0;
    let raf = 0;
    const frame = () => {
      // Re-read the ink now and then so a theme swap retints without a getComputedStyle every frame.
      if (tick++ % 30 === 0) ink = readInk(canvas);
      smoothed = smoothBands(smoothed, getLatestSpectrum(), ATTACK, DECAY);
      draw(smoothed);
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);

    const ro = new ResizeObserver(() => fit());
    ro.observe(canvas);

    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
    };
  }, []);

  return <canvas ref={canvasRef} className={styles.ridge} aria-hidden="true" />;
}
