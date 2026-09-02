/*
 * The player's spectrum feed, kept off the React render path. The engine emits `player:spectrum` about
 * thirty times a second while audible; a render on every frame would thrash the tree, so the raw bands
 * land in a module-level singleton the visualizer polls from its own animation frame instead of through
 * state. `smoothBands` is the pure easing the visualizer runs per frame, tested apart from the DOM.
 */

// -- Framework Imports --
import { useEffect } from "react";

// -- Library Imports --
import { listen } from "@tauri-apps/api/event";

// -- Type Imports --
import { BAND_COUNT, type SpectrumBands } from "../../types";

/** A fresh rest frame: every band at zero. New each call so no caller shares a mutable buffer. */
function restBands(): number[] {
  return new Array(BAND_COUNT).fill(0);
}

// The latest raw bands from the engine, held outside React so the ~30fps feed never fires a render.
// The visualizer reads it through getLatestSpectrum on its own frame.
let latest: number[] = restBands();

/** The latest raw spectrum frame the engine emitted, or a zero frame before the first one arrives. */
export function getLatestSpectrum(): number[] {
  return latest;
}

/** Stores one raw spectrum frame. Internal to the sync hook; consumers only read. */
function setLatestSpectrum(bands: number[]): void {
  latest = bands;
}

/**
 * Eases `prev` toward `target` per band: a band that rose moves by the `attack` fraction of the gap
 * (fast), a band that fell by the `decay` fraction (slow), so bars snap up and settle down. Pure and
 * deterministic. A length mismatch restarts from a zero frame of the target's length, so a band-count
 * change never blends against a stale buffer.
 */
export function smoothBands(
  prev: number[],
  target: number[],
  attack: number,
  decay: number,
): number[] {
  const base = prev.length === target.length ? prev : new Array(target.length).fill(0);
  return target.map((t, i) => {
    const p = base[i];
    const rate = t > p ? attack : decay;
    return p + (t - p) * rate;
  });
}

/**
 * Folds the raw bands into three levels - the low, mid and high thirds - taking the max of each third so
 * the three-bar glyph reads the beat rather than an averaged mush. A short or empty frame yields three
 * zeros. Pure and length-tolerant: the last third takes the remainder when the count divides unevenly.
 */
export function foldToThirds(bands: number[]): [number, number, number] {
  const n = bands.length;
  if (n === 0) return [0, 0, 0];
  const size = n / 3;
  const out: [number, number, number] = [0, 0, 0];
  for (let g = 0; g < 3; g++) {
    const start = Math.floor(g * size);
    const end = g === 2 ? n : Math.floor((g + 1) * size);
    let max = 0;
    for (let i = start; i < end; i++) {
      if (bands[i] > max) max = bands[i];
    }
    out[g] = max;
  }
  return out;
}

/**
 * Follows the engine's `player:spectrum` event into the singleton for the app's life. Mount once beside
 * usePlayerSync; the listener tears down on unmount. No mount seed - the spectrum is live-only and
 * starts at rest.
 */
export function useSpectrumSync(): void {
  useEffect(() => {
    let alive = true;
    let unlisten: (() => void) | null = null;

    void listen<SpectrumBands>("player:spectrum", (e) => {
      setLatestSpectrum(e.payload);
    })
      .then((fn) => {
        if (alive) {
          unlisten = fn;
        } else {
          fn();
        }
      })
      .catch(() => {});

    return () => {
      alive = false;
      if (unlisten) unlisten();
    };
  }, []);
}
