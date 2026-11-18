// -- Test Imports --
import { describe, expect, it } from "vitest";

// -- Unit Imports --
import { LAB_LAYOUTS, LAB_LAYOUT_IDS, isAmbientLayout } from "./labScene";

describe("LAB_LAYOUTS", () => {
  it("has a layout for every id", () => {
    for (const id of LAB_LAYOUT_IDS) expect(LAB_LAYOUTS[id].id).toBe(id);
  });

  it("treats every layout but the Player as an ambient stage", () => {
    expect(isAmbientLayout("player")).toBe(false);
    expect(isAmbientLayout("ambient")).toBe(true);
    expect(isAmbientLayout("ambient-side")).toBe(true);
  });

  it("puts the cover left of the words and both above the seek bar in the side layout", () => {
    const { cover, hush, floor, width, height } = LAB_LAYOUTS["ambient-side"];
    const [cx, cy, cw, ch] = cover;
    const [hx, hy, hw, hh] = hush[0];
    expect(cx + cw).toBeLessThan(hx);
    expect(hx + hw).toBeLessThanOrEqual(width);
    expect(Math.max(cy + ch, hy + hh)).toBeLessThan(floor ?? height);
  });
});
