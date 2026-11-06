// -- Test Imports --
import { describe, expect, it } from "vitest";

// -- Unit Imports --
import { WHEEL_STEP, accumulateWheel, shelfIntent } from "./useShelfKeys";

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
  it("turns one mouse notch into one record", () => {
    expect(accumulateWheel(0, { deltaX: 0, deltaY: 100, deltaMode: 0 })).toEqual({ steps: 1, acc: 40 });
    expect(accumulateWheel(0, { deltaX: 0, deltaY: -100, deltaMode: 0 })).toEqual({ steps: -1, acc: -40 });
  });

  it("adds small trackpad deltas up to a record", () => {
    let acc = 0;
    let steps = 0;
    for (let i = 0; i < 6; i++) {
      const next = accumulateWheel(acc, { deltaX: 0, deltaY: 12, deltaMode: 0 });
      acc = next.acc;
      steps += next.steps;
    }
    expect(steps).toBe(1);
    expect(acc).toBe(72 - WHEEL_STEP);
  });

  it("scales line-mode deltas and reads the dominant axis", () => {
    expect(accumulateWheel(0, { deltaX: 0, deltaY: 3, deltaMode: 1 }).steps).toBe(1);
    expect(accumulateWheel(0, { deltaX: -130, deltaY: 4, deltaMode: 0 }).steps).toBe(-2);
  });
});
