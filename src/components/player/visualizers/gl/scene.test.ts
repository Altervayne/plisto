// -- Test Imports --
import { describe, expect, it, vi } from "vitest";

// -- Unit Imports --
import { FLUID_PRELUDE } from "./fluid";
import { SCENE_PRELUDE, setScene } from "./scene";

// -- Type Imports --
import type { Frame, Kit, Program } from "./kit";

describe("SCENE_PRELUDE", () => {
  it("is the fluid prelude with the level and a zero backdrop", () => {
    expect(SCENE_PRELUDE.startsWith(FLUID_PRELUDE)).toBe(true);
    expect(SCENE_PRELUDE).toContain("uniform float uLevel;");
    expect(SCENE_PRELUDE).toContain("const float uBackdrop = 0.0;");
  });
});

describe("setScene", () => {
  it("sends the eased level as uLevel on top of the fluid uniforms", () => {
    const sent = new Map<string, number>();
    const gl = { uniform3f: vi.fn(), uniform2fv: vi.fn() };
    const kit = {
      gl,
      geo: { floor: 0 },
      uniform: () => ({}),
      setCommon: vi.fn(),
      set1: (_p: Program, name: string, v: number) => sent.set(name, v),
      bindTex: vi.fn(),
    } as unknown as Kit;
    const frame = { sig: { level: 0.42, swell: 0.1, bassMotion: 0, midMotion: 0, highMotion: 0 }, light: false, ground: [0, 0, 0] } as unknown as Frame;
    setScene(kit, {} as Program, frame, 0, null, null);
    expect(sent.get("uLevel")).toBe(0.42);
    expect(sent.get("uLight")).toBe(0);
    expect(kit.setCommon).toHaveBeenCalledOnce();
  });
});
