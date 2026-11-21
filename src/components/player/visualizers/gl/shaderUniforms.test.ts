// -- Test Imports --
import { describe, expect, it } from "vitest";

// -- Unit Imports --
import { programsOf } from "../visualizerViews";

// -- State Imports --
import { VISUALIZER_KINDS, isGlKind } from "../../../../state/player/visualizerKind";

const sources = import.meta.glob<string>("./*.ts", { query: "?raw", import: "default", eager: true });

/** The names a shader source declares as uniforms, one entry per declaration. */
function declared(src: string): string[] {
  const names: string[] = [];
  for (const m of src.matchAll(/^\s*uniform\s+(?:(?:lowp|mediump|highp)\s+)?\w+\s+([^;]+);/gm)) {
    for (const part of m[1].split(",")) names.push(part.trim().replace(/\s*\[.*$/, ""));
  }
  return names;
}

/** The uniform names a scene file sets or looks up by a string literal. */
function usedBy(text: string): string[] {
  const names = new Set<string>();
  for (const m of text.matchAll(/\b(?:set[1-4i]|uniform|bindTex)\(\s*\w+,\s*"(\w+)"/g)) names.add(m[1]);
  return [...names];
}

describe("shader uniforms", () => {
  const glKinds = VISUALIZER_KINDS.filter(isGlKind);

  it.each(glKinds)("%s declares each uniform once in each stage", (kind) => {
    for (const p of programsOf(kind)) {
      for (const stage of [p.vs, p.fs]) {
        const names = declared(stage);
        const dupes = names.filter((n, i) => names.indexOf(n) !== i);
        expect(dupes, `${p.name} redeclares`).toEqual([]);
      }
    }
  });

  it.each(glKinds)("%s declares every uniform its file sets by name", (kind) => {
    const progs = programsOf(kind);
    const files = Object.entries(sources).filter(
      ([path, text]) => !path.endsWith(".test.ts") && progs.some((p) => text.includes(`name: "${p.name}"`)),
    );
    expect(files.length).toBeGreaterThan(0);
    const known = new Set(progs.flatMap((p) => [...declared(p.vs), ...declared(p.fs)]));
    for (const [path, text] of files) {
      const missing = usedBy(text).filter((n) => !known.has(n));
      expect(missing, `${path} sets an undeclared uniform`).toEqual([]);
    }
  });
});
