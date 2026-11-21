import { describe, expect, it, vi } from "vitest";
import { createVisibilityState, isSlotVisible, type VisibilityInputs } from "./visibility";

const shown: VisibilityInputs = {
  documentVisible: true,
  intersecting: true,
  opacity: 1,
  mounting: false,
  minimized: false,
};

describe("isSlotVisible", () => {
  it("is visible when shown, on screen and opaque", () => {
    expect(isSlotVisible(shown)).toBe(true);
  });

  it("is hidden with the document hidden, the window minimized or the slot off screen", () => {
    expect(isSlotVisible({ ...shown, documentVisible: false })).toBe(false);
    expect(isSlotVisible({ ...shown, minimized: true })).toBe(false);
    expect(isSlotVisible({ ...shown, intersecting: false })).toBe(false);
  });

  it("is hidden at opacity 0 outside a mount", () => {
    expect(isSlotVisible({ ...shown, opacity: 0 })).toBe(false);
  });

  it("keeps a mounting slot at opacity 0 visible", () => {
    expect(isSlotVisible({ ...shown, opacity: 0, mounting: true })).toBe(true);
  });

  it("still hides a mounting slot that is off screen or in a hidden document", () => {
    expect(isSlotVisible({ ...shown, opacity: 0, mounting: true, intersecting: false })).toBe(false);
    expect(isSlotVisible({ ...shown, opacity: 0, mounting: true, documentVisible: false })).toBe(false);
  });
});

describe("createVisibilityState", () => {
  it("fires only when visibility flips", () => {
    const onChange = vi.fn();
    const state = createVisibilityState({ opacity: 1 }, onChange);
    state.set({ intersecting: true });
    state.set({ opacity: 0.5 });
    state.set({ documentVisible: false });
    state.set({ minimized: true });
    state.set({ documentVisible: true, minimized: false });
    expect(onChange.mock.calls).toEqual([[true], [false], [true]]);
    expect(state.visible()).toBe(true);
  });
});
