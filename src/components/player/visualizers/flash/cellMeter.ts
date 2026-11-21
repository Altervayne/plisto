/*
 * The run-time flash meter: the flash meter over a 64 x 36 grid of cells, fed readings of the stage at a
 * few hertz. A missing reading is a gap, never a zero: it ends the series, and the next reading starts a
 * fresh one, so no transition is ever completed across frames that were not seen.
 */

// -- Local Imports --
import { createFlashMeter, redness, relativeLuminance } from "./flashMeter";

// -- Type Imports --
import type { FlashMeter } from "./flashMeter";

export const CELL_W = 64;
export const CELL_H = 36;
// Readings per second the meter aims for; a second of history is this many readings.
export const CELL_HZ = 20;
// A window is a third of the stage each way.
export const CELL_WINDOW_W = 21;
export const CELL_WINDOW_H = 12;
// A luminance transition is a move of this much in relative luminance with its darker end under the ceiling.
export const LUMA_STEP = 0.1;
export const LUMA_DARKER_BELOW = 0.8;
// A red transition is a move of this much in the saturated-red measure.
export const RED_STEP = 20;
// More flashes than this in any second is a violation. A red flash is one past RED_FLASHES_LIMIT.
export const FLASHES_PER_SEC_LIMIT = 3;
export const RED_FLASHES_LIMIT = 0;

/** What a run of readings has shown so far. */
export interface CellReading {
  flashesPerSec: number;
  redFlashesPerSec: number;
  // The largest share of a one-third-stage window that flashed, 0..1.
  area: number;
}

export interface CellMeter {
  /** Feeds one reading: the stage as CELL_W x CELL_H RGBA bytes. */
  frame: (bytes: Uint8Array) => void;
  /** Reports that no reading was taken; the next one starts a fresh series. */
  gap: () => void;
  /** The worst the readings have shown, over every series. */
  reading: () => CellReading;
  /** Whether the worst reading breaks the rule. */
  tripped: () => boolean;
}

interface Series {
  luma: FlashMeter;
  red: FlashMeter;
}

export function createCellMeter(): CellMeter {
  const n = CELL_W * CELL_H;
  const lumaValues = new Float32Array(n);
  const redValues = new Float32Array(n);
  const window = { winW: CELL_WINDOW_W, winH: CELL_WINDOW_H, rate: CELL_HZ };
  let series: Series | null = null;
  let worst: CellReading = { flashesPerSec: 0, redFlashesPerSec: 0, area: 0 };

  const start = (): Series => ({
    luma: createFlashMeter(CELL_W, CELL_H, { ...window, step: LUMA_STEP, darkerBelow: LUMA_DARKER_BELOW }),
    red: createFlashMeter(CELL_W, CELL_H, { ...window, step: RED_STEP, darkerBelow: null }),
  });

  const tripped = (r: CellReading) =>
    r.flashesPerSec > FLASHES_PER_SEC_LIMIT || r.redFlashesPerSec > RED_FLASHES_LIMIT;

  return {
    frame(bytes) {
      series ??= start();
      for (let i = 0; i < n; i++) {
        lumaValues[i] = relativeLuminance(bytes, i * 4);
        redValues[i] = redness(bytes, i * 4);
      }
      series.luma.frame(lumaValues);
      series.red.frame(redValues);
      const luma = series.luma.result();
      worst = {
        flashesPerSec: Math.max(worst.flashesPerSec, luma.flashesPerSec),
        redFlashesPerSec: Math.max(worst.redFlashesPerSec, series.red.result().flashesPerSec),
        area: Math.max(worst.area, luma.flickerShare),
      };
    },
    gap() {
      series = null;
    },
    reading: () => worst,
    tripped: () => tripped(worst),
  };
}
