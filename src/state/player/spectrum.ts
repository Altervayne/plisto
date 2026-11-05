/*
 * The player's spectrum feed, kept off the React render path. The engine emits `player:spectrum` and
 * `player:level` about thirty times a second while audible; a render on every frame would thrash the
 * tree, so each payload lands in a module-level singleton the visualizers poll from their own animation
 * frame instead of through state. The 128-band `player:spectrum_fine` emit is opt-in: it runs only while
 * a holder has acquired it. `smoothBands` is the pure easing the visualizers run per frame, tested apart
 * from the DOM.
 */

// -- Framework Imports --
import { useEffect } from "react";

// -- Library Imports --
import { listen } from "@tauri-apps/api/event";

// -- IPC Imports --
import { playerSetFineSpectrum } from "../../lib/ipc";

// -- Type Imports --
import { BAND_COUNT, type LevelFrame, type SpectrumBands } from "../../types";

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

// The latest level frame, at rest until the first emit.
let latestLevel: LevelFrame = { rms: 0, peak: 0, flux: 0 };

/** The latest level frame the engine emitted, or a zero frame before the first one arrives. */
export function getLatestLevel(): LevelFrame {
  return latestLevel;
}

// The latest fine frame, or null while no fine emit has landed since the feed was last switched on.
let latestFine: number[] | null = null;
let fineHolders = 0;

/** The latest 128-band frame, or null when the engine has sent none, so a reader falls back to 24 bands. */
export function getLatestFineSpectrum(): number[] | null {
  return latestFine;
}

/**
 * Asks the engine for the fine spectrum while at least one holder is mounted, and returns the release.
 * Best-effort: an engine without the command never emits, and the reader keeps its 24-band fallback.
 */
export function acquireFineSpectrum(): () => void {
  fineHolders += 1;
  if (fineHolders === 1) void playerSetFineSpectrum(true).catch(() => {});
  let released = false;
  return () => {
    if (released) return;
    released = true;
    fineHolders -= 1;
    if (fineHolders > 0) return;
    latestFine = null;
    void playerSetFineSpectrum(false).catch(() => {});
  };
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

/** Follows one engine event into a handler; the returned stop tears the listener down, even mid-subscribe. */
function follow<T>(event: string, handler: (payload: T) => void): () => void {
  let alive = true;
  let unlisten: (() => void) | null = null;
  void listen<T>(event, (e) => handler(e.payload))
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
}

/**
 * Follows the engine's spectrum, level and fine spectrum events into their singletons for the app's
 * life. Mount once beside usePlayerSync; the listeners tear down on unmount. No mount seed - the feed is
 * live-only and starts at rest. A fine frame landing after the last release is dropped.
 */
export function useSpectrumSync(): void {
  useEffect(() => {
    const stops = [
      follow<SpectrumBands>("player:spectrum", setLatestSpectrum),
      follow<LevelFrame>("player:level", (frame) => {
        latestLevel = frame;
      }),
      follow<SpectrumBands>("player:spectrum_fine", (bands) => {
        if (fineHolders > 0) latestFine = bands;
      }),
    ];
    return () => stops.forEach((stop) => stop());
  }, []);
}
