// -- Test Imports --
import { describe, expect, it } from "vitest";

// -- Unit Imports --
import { WHEEL_NOTCH_PX, WHEEL_STEP, accumulateWheel, shelfIntent } from "./useShelfKeys";

const key = (k: string, mods: Partial<Record<"shiftKey" | "ctrlKey" | "metaKey" | "altKey", boolean>> = {}) =>
  shelfIntent({ key: k, shiftKey: false, ctrlKey: false, metaKey: false, altKey: false, ...mods });

describe("shelfIntent", () => {
  it("steps one record on either axis", () => {
    expect(key("ArrowRight")).toEqual({ kind: "step", by: 1 });
    expect(key("ArrowDown")).toEqual({ kind: "step", by: 1 });
    expect(key("ArrowLeft")).toEqual({ kind: "step", by: -1 });
    expect(key("ArrowUp")).toEqual({ kind: "step", by: -1 });
  });

  it("pages, jumps to the ends, activates and opens the menu", () => {
    expect(key("PageDown")).toEqual({ kind: "page", dir: 1 });
    expect(key("PageUp")).toEqual({ kind: "page", dir: -1 });
    expect(key("Home")).toEqual({ kind: "home" });
    expect(key("End")).toEqual({ kind: "end" });
    expect(key("Enter")).toEqual({ kind: "activate" });
    expect(key(" ")).toEqual({ kind: "activate" });
    expect(key("ContextMenu")).toEqual({ kind: "menu" });
    expect(key("F10", { shiftKey: true })).toEqual({ kind: "menu" });
  });

  it("leaves modified keys to the app shortcuts", () => {
    expect(key("ArrowRight", { ctrlKey: true })).toBeNull();
    expect(key("ArrowRight", { shiftKey: true })).toBeNull();
    expect(key(" ", { altKey: true })).toBeNull();
    expect(key("F10")).toBeNull();
    expect(key("a")).toBeNull();
  });
});

describe("accumulateWheel", () => {
  const pixel = (deltaY: number, deltaX = 0) => ({ deltaX, deltaY, deltaMode: 0 });

  it("moves one record per line-mode notch, whatever the line count", () => {
    expect(accumulateWheel(0, { deltaX: 0, deltaY: 3, deltaMode: 1 })).toEqual({ steps: 1, acc: 0 });
    expect(accumulateWheel(0, { deltaX: 0, deltaY: -1, deltaMode: 1 })).toEqual({ steps: -1, acc: 0 });
    expect(accumulateWheel(0, { deltaX: 0, deltaY: 1, deltaMode: 2 })).toEqual({ steps: 1, acc: 0 });
  });

  it("reads one large pixel delta as a notch: one record, partial total dropped", () => {
    expect(accumulateWheel(0, pixel(100))).toEqual({ steps: 1, acc: 0 });
    expect(accumulateWheel(0, pixel(-240))).toEqual({ steps: -1, acc: 0 });
    expect(accumulateWheel(30, pixel(WHEEL_NOTCH_PX))).toEqual({ steps: 1, acc: 0 });
  });

  it("adds small trackpad deltas up to a record", () => {
    let acc = 0;
    let steps = 0;
    for (let i = 0; i < 6; i++) {
      const next = accumulateWheel(acc, pixel(12));
      acc = next.acc;
      steps += next.steps;
    }
    expect(steps).toBe(1);
    expect(acc).toBe(72 - WHEEL_STEP);
  });

  it("keeps a sub-notch delta below a record", () => {
    expect(accumulateWheel(0, pixel(WHEEL_NOTCH_PX - 1))).toEqual({ steps: 0, acc: WHEEL_NOTCH_PX - 1 });
    expect(accumulateWheel(20, pixel(45))).toEqual({ steps: 1, acc: 5 });
  });

  it("reads the dominant axis and ignores an empty event", () => {
    expect(accumulateWheel(0, pixel(4, -30))).toEqual({ steps: 0, acc: -30 });
    expect(accumulateWheel(0, pixel(4, -130)).steps).toBe(-1);
    expect(accumulateWheel(25, pixel(0))).toEqual({ steps: 0, acc: 25 });
  });
});
