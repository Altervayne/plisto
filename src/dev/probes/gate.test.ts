// -- Test Imports --
import { describe, expect, it } from "vitest";

// Every file of the app outside the probes folder, as text.
const outside = import.meta.glob<string>(["../../**/*.{ts,tsx}", "!../../dev/probes/**"], {
  query: "?raw",
  import: "default",
  eager: true,
});

/** The source with comments blanked to spaces, so offsets stay valid and prose never counts as code. */
function code(src: string): string {
  return src.replace(/\/\*[\s\S]*?\*\/|\/\/[^\n]*/g, (m) => m.replace(/[^\n]/g, " "));
}

/** The offset ranges of every block opened by an `import.meta.env.DEV` condition, condition included. */
function devRegions(src: string): [number, number][] {
  const regions: [number, number][] = [];
  for (let at = src.indexOf("import.meta.env.DEV"); at >= 0; at = src.indexOf("import.meta.env.DEV", at + 1)) {
    const open = src.indexOf("{", at);
    if (open < 0) continue;
    let depth = 0;
    let close = open;
    for (; close < src.length; close++) {
      if (src[close] === "{") depth++;
      else if (src[close] === "}" && --depth === 0) break;
    }
    regions.push([src.lastIndexOf("\n", at) + 1, close + 1]);
  }
  return regions;
}

/** The offsets of probes references that sit outside every DEV-guarded block. */
function unguarded(source: string): number[] {
  const src = code(source);
  const regions = devRegions(src);
  const hits: number[] = [];
  for (const m of src.matchAll(/probes/gi)) {
    const at = m.index as number;
    if (!regions.some(([from, to]) => at >= from && at < to)) hits.push(at);
  }
  return hits;
}

describe("probes gate", () => {
  const main = outside["../../main.tsx"];

  it("keeps every probes reference in main.tsx inside the DEV branch", () => {
    expect(main).toContain("probes");
    expect(unguarded(main)).toEqual([]);
  });

  it("keeps the lazy import itself inside the DEV branch", () => {
    const src = code(main);
    const lazy = src.indexOf("React.lazy");
    expect(lazy).toBeGreaterThan(0);
    expect(devRegions(src).some(([from, to]) => lazy >= from && lazy < to)).toBe(true);
  });

  it("flags a reference that sits outside the guard", () => {
    const bad = [
      'const ProbesPage = React.lazy(() => import("./dev/probes/ProbesPage"));',
      "if (import.meta.env.DEV) {",
      '  location.search = "?window=probes";',
      "}",
    ].join("\n");
    expect(unguarded(bad).length).toBeGreaterThan(0);
    expect(unguarded(bad.split("\n").slice(1).join("\n"))).toEqual([]);
  });

  it("has no importer of the probes folder outside it other than main.tsx", () => {
    const importers = Object.entries(outside)
      .filter(([path, src]) => /(?:from\s*|import\s*\(?\s*)["'][^"']*dev\/probes/.test(code(src)) && path !== "../../main.tsx")
      .map(([path]) => path);
    expect(importers).toEqual([]);
  });
});
