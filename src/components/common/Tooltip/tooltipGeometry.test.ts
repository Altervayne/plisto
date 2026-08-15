// -- Test Imports --
import { describe, expect, it } from "vitest";

// -- Unit Imports --
import { placeTooltip } from "./tooltipGeometry";

const viewport = { width: 1000, height: 800 };
// A small trigger comfortably in the middle of the viewport.
const centered = { top: 400, left: 480, width: 40, height: 20 };
const bubble = { width: 120, height: 30 };

describe("placeTooltip", () => {
  it("keeps the preferred side when it fits and centers the bubble on the trigger", () => {
    const placed = placeTooltip(centered, bubble, viewport, "top", 8, 6);
    expect(placed.placement).toBe("top");
    // Above the trigger by the gap and the bubble's own height.
    expect(placed.top).toBe(400 - 8 - 30);
    // Centered: trigger center 500, minus half the bubble width.
    expect(placed.left).toBe(500 - 60);
  });

  it("flips top to bottom when the trigger hugs the top edge", () => {
    const highUp = { top: 4, left: 480, width: 40, height: 20 };
    const placed = placeTooltip(highUp, bubble, viewport, "top", 8, 6);
    expect(placed.placement).toBe("bottom");
    expect(placed.top).toBe(4 + 20 + 8);
  });

  it("flips bottom to top when the trigger hugs the bottom edge", () => {
    const lowDown = { top: 790, left: 480, width: 40, height: 20 };
    const placed = placeTooltip(lowDown, bubble, viewport, "bottom", 8, 6);
    expect(placed.placement).toBe("top");
    expect(placed.top).toBe(790 - 8 - 30);
  });

  it("flips left to right when there is no room on the left", () => {
    const nearLeft = { top: 400, left: 10, width: 40, height: 20 };
    const placed = placeTooltip(nearLeft, bubble, viewport, "left", 8, 6);
    expect(placed.placement).toBe("right");
    expect(placed.left).toBe(10 + 40 + 8);
  });

  it("clamps the horizontal overhang so a top bubble never leaves the right edge", () => {
    const nearRight = { top: 400, left: 960, width: 40, height: 20 };
    const placed = placeTooltip(nearRight, bubble, viewport, "top", 8, 6);
    expect(placed.placement).toBe("top");
    // Right edge minus margin minus width: 1000 - 6 - 120.
    expect(placed.left).toBe(1000 - 6 - 120);
  });

  it("clamps the vertical overhang so a right bubble never leaves the top edge", () => {
    const tallBubble = { width: 120, height: 300 };
    const highRight = { top: 20, left: 480, width: 40, height: 20 };
    const placed = placeTooltip(highRight, tallBubble, viewport, "right", 8, 6);
    expect(placed.placement).toBe("right");
    expect(placed.top).toBe(6);
  });

  it("keeps the preferred side when neither it nor its opposite fits", () => {
    // A bubble taller than the viewport can never fit above or below; the preferred side holds.
    const hugeBubble = { width: 120, height: 900 };
    const placed = placeTooltip(centered, hugeBubble, viewport, "top", 8, 6);
    expect(placed.placement).toBe("top");
  });
});
