// -- Test Imports --
import { describe, expect, it } from "vitest";

// -- Unit Imports --
import { placeBeside, placeMenu } from "./menuGeometry";

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

describe("placeMenu forceFlip", () => {
  it("grows upward and leftward from the point when both axes are forced", () => {
    const placed = placeMenu({ x: 500, y: 400 }, menu, viewport, 6, { x: true, y: true });
    expect(placed.left).toBe(500 - 200);
    expect(placed.top).toBe(400 - 300);
    expect(placed.origin).toBe("right bottom");
  });

  it("leaves an axis alone when only the other is forced", () => {
    const placed = placeMenu({ x: 300, y: 400 }, menu, viewport, 6, { y: true });
    expect(placed.left).toBe(300);
    expect(placed.top).toBe(100);
  });
});

describe("placeBeside", () => {
  const panel = { width: 440, height: 300 };
  const box = (left: number, top: number, width: number, height: number) => ({
    left,
    top,
    right: left + width,
    bottom: top + height,
  });

  it("opens right of the menu with its top just above the row", () => {
    const placed = placeBeside(box(100, 150, 210, 260), box(105, 300, 200, 30), panel, viewport, 6);
    expect(placed.x).toBe(310 + 6);
    expect(placed.y).toBe(300 - 8);
  });

  it("flips to the left of the menu when the right side is short", () => {
    const placed = placeBeside(box(600, 150, 210, 260), box(605, 300, 200, 30), panel, viewport, 6);
    expect(placed.x).toBe(600 - 6 - 440);
    expect(placed.y).toBe(300 - 8);
  });

  it("keeps the right side when the panel fits exactly inside the margin", () => {
    // 1000 - 6 - 440 - 6 = 548 leaves the panel's right edge on the margin.
    const placed = placeBeside(box(338, 150, 210, 260), box(343, 300, 200, 30), panel, viewport, 6);
    expect(placed.x).toBe(548 + 6);
  });

  it("clamps a flipped panel to the left margin when neither side has room", () => {
    const narrow = { width: 700, height: 800 };
    const placed = placeBeside(box(250, 150, 210, 260), box(255, 300, 200, 30), panel, narrow, 6);
    expect(placed.x).toBe(6);
  });

  it("pins a panel wider than the viewport to the left margin", () => {
    const placed = placeBeside(box(100, 150, 210, 260), box(105, 300, 200, 30), { width: 1200, height: 300 }, viewport, 6);
    expect(placed.x).toBe(6);
  });

  it("clamps to the top margin for a row near the top", () => {
    const placed = placeBeside(box(100, 4, 210, 260), box(105, 8, 200, 30), panel, viewport, 6);
    expect(placed.y).toBe(6);
  });

  it("clamps to the bottom margin for a row near the bottom", () => {
    const placed = placeBeside(box(100, 500, 210, 260), box(105, 700, 200, 30), panel, viewport, 6);
    expect(placed.y).toBe(800 - 6 - 300);
  });

  it("pins a panel taller than the viewport to the top margin", () => {
    const placed = placeBeside(box(100, 150, 210, 260), box(105, 300, 200, 30), { width: 440, height: 900 }, viewport, 6);
    expect(placed.y).toBe(6);
  });
});
