// -- Test Imports --
import { describe, expect, it } from "vitest";

// -- Unit Imports --
import { COMPOSITE_OP, flipRows, rgbCss } from "./labCompose";

describe("flipRows", () => {
  it("reverses the rows of a top-down image into the order readPixels returns", () => {
    // Two 2-pixel rows: row 0 is 1..8, row 1 is 9..16.
    const top = Uint8Array.from({ length: 16 }, (_, i) => i + 1);
    const out = new Uint8Array(16);
    flipRows(top, out, 2, 2);
    expect(Array.from(out)).toEqual([9, 10, 11, 12, 13, 14, 15, 16, 1, 2, 3, 4, 5, 6, 7, 8]);
  });
});

describe("rgbCss", () => {
  it("rounds an sRGB triple to bytes", () => {
    expect(rgbCss([1, 0.5, 0])).toBe("rgb(255,128,0)");
  });
});

describe("COMPOSITE_OP", () => {
  it("maps each CSS blend to its 2D operation", () => {
    expect(COMPOSITE_OP).toEqual({ screen: "screen", multiply: "multiply", normal: "source-over" });
  });
});
