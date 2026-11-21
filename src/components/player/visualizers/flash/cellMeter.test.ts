// -- Test Imports --
import { describe, expect, it } from "vitest";

// -- Unit Imports --
import {
  CELL_H,
  CELL_HZ,
  CELL_W,
  FLASHES_PER_SEC_LIMIT,
  RED_FLASHES_LIMIT,
  createCellMeter,
} from "./cellMeter";

const GREY = (v: number): [number, number, number] => [v, v, v];
const DARK = GREY(50);
const BRIGHT = GREY(160);

/** A stage of one colour. */
function stage(color: [number, number, number]): Uint8Array {
  const bytes = new Uint8Array(CELL_W * CELL_H * 4);
  for (let i = 0; i < bytes.length; i += 4) bytes.set([...color, 255], i);
  return bytes;
}

/** Readings at CELL_HZ over `seconds`, alternating at `hz` flashes a second. */
function wave(hz: number, seconds: number, a: [number, number, number], b: [number, number, number], gaps = false) {
  const meter = createCellMeter();
  const lo = stage(a);
  const hi = stage(b);
  for (let f = 0; f < seconds * CELL_HZ; f++) {
    if (gaps) meter.gap();
    meter.frame(Math.floor((f * 2 * hz) / CELL_HZ) % 2 === 0 ? lo : hi);
  }
  return meter;
}

describe("cell meter limits", () => {
  it("pins the flash limits so neither moves unnoticed", () => {
    expect(FLASHES_PER_SEC_LIMIT).toBe(3);
    expect(RED_FLASHES_LIMIT).toBe(0);
  });
});

describe("createCellMeter", () => {
  it("never completes a transition across a gap", () => {
    expect(wave(5, 3, DARK, BRIGHT).tripped()).toBe(true);
    const gapped = wave(5, 3, DARK, BRIGHT, true);
    expect(gapped.reading().flashesPerSec).toBe(0);
    expect(gapped.tripped()).toBe(false);
  });

  it("trips on a red flash alone", () => {
    // Equal luminance, so only the red measure moves.
    const meter = wave(2, 3, GREY(127), [255, 0, 0]);
    expect(meter.reading().flashesPerSec).toBe(0);
    expect(meter.reading().redFlashesPerSec).toBeGreaterThan(0);
    expect(meter.tripped()).toBe(true);
  });

  it("passes a full-stage square wave at 3 a second", () => {
    const meter = wave(3, 4, DARK, BRIGHT);
    expect(meter.reading().flashesPerSec).toBe(3);
    expect(meter.tripped()).toBe(false);
  });

  it("trips a full-stage square wave at 4 a second", () => {
    const meter = wave(4, 4, DARK, BRIGHT);
    expect(meter.reading().flashesPerSec).toBeGreaterThan(3);
    expect(meter.tripped()).toBe(true);
  });

  it("passes a 4 a second wave over under a quarter of a window", () => {
    const meter = createCellMeter();
    const lo = stage(DARK);
    const hi = stage(DARK);
    for (let y = 0; y < 6; y++) for (let x = 0; x < 10; x++) hi.set([...BRIGHT, 255], (y * CELL_W + x) * 4);
    for (let f = 0; f < 4 * CELL_HZ; f++) meter.frame(Math.floor((f * 8) / CELL_HZ) % 2 === 0 ? lo : hi);
    expect(meter.tripped()).toBe(false);
  });
});
