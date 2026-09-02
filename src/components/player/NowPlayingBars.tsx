// -- Framework Imports --
import { useEffect, useRef } from "react";

// -- State Imports --
import { foldToThirds, getLatestSpectrum, smoothBands } from "../../state/player/spectrum";

// -- Style Imports --
import styles from "./NowPlayingBars.module.css";

// Fast-attack, slow-decay ballistics, matching the ridge: the bars snap up on a hit and ease back down.
const ATTACK = 0.5;
const DECAY = 0.15;

// The bar heights the level 0..1 maps across, in pixels.
const MIN_H = 4;
const MAX_H = 13;

// The settle chord the bars ease to when the feed goes silent - the same staggered heights the
// reduced-motion glyph holds, so a pause lands on a shape rather than a flat line.
const REST_H = [7, 13, 5];
const REST_LEVELS = REST_H.map((h) => (h - MIN_H) / (MAX_H - MIN_H));

/** True when the frame carries no energy, as the engine emits at a pause or stop. */
function silent(bands: number[]): boolean {
  for (const b of bands) {
    if (b > 0.0001) return false;
  }
  return true;
}

/**
 * The three-bar equalizer glyph marking the row the engine is on. Neutral ink, not accent - it reads
 * "this one" by motion and weight, leaving the seek fill the sole lit mark. It drives the bar heights
 * imperatively from the spectrum feed on its own animation frame, so the ~30fps beat never fires a
 * render. A silent feed eases the bars down to a resting chord; a reduced-motion preference holds that
 * chord from CSS and runs no loop.
 */
export function NowPlayingBars() {
  const barsRef = useRef<HTMLSpanElement>(null);

  useEffect(() => {
    const root = barsRef.current;
    if (!root) return;
    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;

    const bars = Array.from(root.children) as HTMLElement[];
    let level: number[] = [0, 0, 0];
    let raf = 0;

    const frame = () => {
      const raw = getLatestSpectrum();
      const target = silent(raw) ? REST_LEVELS : foldToThirds(raw);
      level = smoothBands(level, target, ATTACK, DECAY);
      for (let i = 0; i < bars.length; i++) {
        bars[i].style.height = `${MIN_H + level[i] * (MAX_H - MIN_H)}px`;
      }
      raf = requestAnimationFrame(frame);
    };
    raf = requestAnimationFrame(frame);

    return () => cancelAnimationFrame(raf);
  }, []);

  return (
    <span ref={barsRef} className={styles.bars} aria-hidden="true">
      <span className={styles.bar} />
      <span className={styles.bar} />
      <span className={styles.bar} />
    </span>
  );
}
