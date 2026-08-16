// -- Test Imports --
import { describe, expect, it } from "vitest";

// -- Unit Imports --
import { placeMenu } from "./menuGeometry";

const viewport = { width: 1000, height: 800 };
const menu = { width: 200, height: 300 };

describe("placeMenu", () => {
  it("opens rightward and downward from the pointer when there is room", () => {
    const placed = placeMenu({ x: 300, y: 200 }, menu, viewport, 6);
    expect(placed.left).toBe(300);
    expect(placed.top).toBe(200);
    expect(placed.origin).toBe("left top");
  });

  it("opens leftward when the menu would overflow the right edge", () => {
    const placed = placeMenu({ x: 900, y: 200 }, menu, viewport, 6);
    // Grows back toward the pointer: pointer minus width.
    expect(placed.left).toBe(900 - 200);
    expect(placed.top).toBe(200);
    expect(placed.origin).toBe("right top");
  });

  it("opens upward when the menu would overflow the bottom edge", () => {
    const placed = placeMenu({ x: 300, y: 700 }, menu, viewport, 6);
    expect(placed.left).toBe(300);
    expect(placed.top).toBe(700 - 300);
    expect(placed.origin).toBe("left bottom");
  });

  it("flips both axes at the bottom-right corner", () => {
    const placed = placeMenu({ x: 950, y: 750 }, menu, viewport, 6);
    expect(placed.left).toBe(950 - 200);
    expect(placed.top).toBe(750 - 300);
    expect(placed.origin).toBe("right bottom");
  });

  it("clamps a flipped menu that still overshoots the near edge", () => {
    // Tall enough that flipping up from a low-ish press would run off the top; the margin holds it.
    const tall = { width: 200, height: 500 };
    const placed = placeMenu({ x: 40, y: 300 }, tall, viewport, 6);
    expect(placed.left).toBe(40);
    expect(placed.top).toBe(6);
  });

  it("pins a menu taller than the viewport to the top margin", () => {
    const tall = { width: 200, height: 900 };
    const placed = placeMenu({ x: 300, y: 400 }, tall, viewport, 6);
    expect(placed.top).toBe(6);
  });
});
