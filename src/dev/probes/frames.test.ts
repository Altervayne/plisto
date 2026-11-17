// -- Test Imports --
import { describe, expect, it } from "vitest";

// -- Unit Imports --
import { applyFrameSize, cssLength, probeUrl } from "./frames";

function fakeFrame(): HTMLIFrameElement {
  return { style: {} } as unknown as HTMLIFrameElement;
}

describe("frame sizing", () => {
  it("reads a number as CSS pixels and a string as given", () => {
    expect(cssLength(480)).toBe("480px");
    expect(cssLength("100%")).toBe("100%");
  });

  it("applies size and border before the frame loads, and nothing that was not asked for", () => {
    const sized = fakeFrame();
    applyFrameSize(sized, { width: 478, height: "100%", borderless: true });
    expect(sized.style).toEqual({ width: "478px", height: "100%", border: "0" });
    const bare = fakeFrame();
    applyFrameSize(bare, {});
    expect(bare.style).toEqual({});
  });

  it("builds the frame url from host and file", () => {
    expect(probeUrl("probe-vis", "vis-raf.html")).toBe("https://probe-vis.invalid/vis-raf.html");
  });
});
