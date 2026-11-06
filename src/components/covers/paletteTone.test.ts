// -- Test Imports --
import { describe, expect, it } from "vitest";

// -- Unit Imports --
import { derivePaletteTone, temper } from "./paletteTone";

describe("temper", () => {
  it("keeps the hue, caps the saturation and draws lightness to the theme target", () => {
    expect(temper({ r: 200, g: 40, b: 40 }, false)).toEqual({ r: 197, g: 52, b: 52 });
    expect(temper({ r: 200, g: 40, b: 40 }, true)).toEqual({ r: 203, g: 61, b: 61 });
  });
});

describe("derivePaletteTone", () => {
  it("paints the warm neutral tint on every bloom and dims the layer without a palette", () => {
    const tint = { r: 159, g: 150, b: 137 };
    expect(derivePaletteTone(null, false, 3)).toEqual({ colors: [tint, tint, tint], opacityFactor: 0.6 });
    expect(derivePaletteTone([], true, 2).colors).toEqual([tint, tint]);
  });

  it("tempers each colour and reuses the last for blooms past the palette", () => {
    expect(
      derivePaletteTone(
        [
          [20, 60, 160],
          [240, 200, 40],
        ],
        true,
        3,
      ),
    ).toEqual({
      colors: [
        { r: 50, g: 90, b: 190 },
        { r: 207, g: 180, b: 74 },
        { r: 207, g: 180, b: 74 },
      ],
      opacityFactor: 1,
    });
  });
});
