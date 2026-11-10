// -- Test Imports --
import { describe, expect, it } from "vitest";

// -- Unit Imports --
import { warmKind } from "./warm";
import { isWarm, useWarmState, warmIn } from "./warmState";
import { programsOf } from "../visualizerViews";
import { SHARED_PROGRAMS } from "./shaders";

// -- State Imports --
import { VISUALIZER_KINDS, isGlKind } from "../../../../state/player/visualizerKind";

const sources = import.meta.glob<string>("./*.ts", { query: "?raw", import: "default", eager: true });

describe("warm state", () => {
  it("counts a kind that draws without WebGL as warm", () => {
    expect(warmIn(new Set(), "ridge")).toBe(true);
    expect(warmIn(new Set(), "off")).toBe(true);
  });

  it("holds a WebGL kind cold until it is marked", () => {
    expect(warmIn(new Set(), "train")).toBe(false);
    expect(warmIn(new Set(["train"]), "train")).toBe(true);
  });

  it("marks a kind warm when no context can open, so the stage never strands", () => {
    expect(isWarm("pond")).toBe(false);
    warmKind("pond");
    expect(isWarm("pond")).toBe(true);
    expect(useWarmState.getState().warmed.has("pond")).toBe(true);
  });
});

describe("program lists", () => {
  const glKinds = VISUALIZER_KINDS.filter(isGlKind);

  it.each(glKinds)("%s lists at least one program", (kind) => {
    expect(programsOf(kind).length).toBeGreaterThan(0);
    for (const p of programsOf(kind)) {
      expect(p.vs.startsWith("#version 300 es")).toBe(true);
      expect(p.fs.startsWith("#version 300 es")).toBe(true);
    }
  });

  it("lists no program for a kind without WebGL", () => {
    expect(programsOf("ridge")).toEqual([]);
  });

  it("names the shared passes", () => {
    expect(SHARED_PROGRAMS.map((p) => p.name).sort()).toEqual(["blur", "composite", "down", "trail"]);
  });

  it("compiles only listed programs: every kit.program call takes a named constant from its file's list", () => {
    for (const [path, text] of Object.entries(sources)) {
      if (path.endsWith(".test.ts") || path.endsWith("/kit.ts")) continue;
      const calls = [...text.matchAll(/kit\.program\(([^)]*)\)/g)].map((m) => m[1].trim());
      if (calls.length === 0) continue;
      // The shared passes are listed in shaders.ts, the rest in the file that compiles them.
      const home = path.endsWith("/renderer.ts") ? sources["./shaders.ts"] : text;
      const lists = [...home.matchAll(/export const \w+_PROGRAMS[^=]*=\s*\[([^\]]*)\]/g)];
      const listed = lists.flatMap((m) => m[1].split(",").map((s) => s.trim()));
      for (const call of calls) {
        expect(call, `${path} passes ${call}`).toMatch(/^[A-Z_]+_PROGRAM$/);
        expect(listed, `${path} lists ${call}`).toContain(call);
      }
    }
  });
});
