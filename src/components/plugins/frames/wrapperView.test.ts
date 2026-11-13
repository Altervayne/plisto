// -- Test Imports --
import { describe, expect, it } from "vitest";

// -- Unit Imports --
import { wrapperView } from "./wrapperView";

const RECT = { top: 10, left: 20, width: 300, height: 200 };

describe("wrapperView", () => {
  it("shows the active page frame at the slot rect once it has answered", () => {
    for (const phase of ["live", "not_responding"] as const) {
      expect(wrapperView({ active: true }, phase, RECT)).toEqual({
        shown: true,
        style: RECT,
        inert: false,
        ariaHidden: false,
      });
    }
  });

  it("hides the active frame until it has answered", () => {
    for (const phase of ["loading", "crashed", "unavailable", undefined] as const) {
      const view = wrapperView({ active: true }, phase, RECT);
      expect(view.shown).toBe(false);
      expect(view.style).toBeUndefined();
      expect(view.inert).toBe(true);
      expect(view.ariaHidden).toBe(true);
    }
  });

  it("hides every frame that is not the active page, whatever its phase", () => {
    const view = wrapperView({ active: false }, "live", RECT);
    expect(view).toEqual({ shown: false, style: undefined, inert: true, ariaHidden: true });
  });

  it("hides the active frame while the slot rect is unknown", () => {
    expect(wrapperView({ active: true }, "live", null).shown).toBe(false);
  });
});
