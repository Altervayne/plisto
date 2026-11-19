// -- Test Imports --
import { describe, expect, it } from "vitest";

// A component that lists kinds or families from the full registry order would show kinds the catalog
// turned off. Only the catalog's own views of that order may reach a component.
const SOURCES = import.meta.glob<string>("../../components/**/*.{ts,tsx}", {
  eager: true,
  query: "?raw",
  import: "default",
});

const FULL_ORDER = /\b(VISUALIZER_KINDS|VISUALIZER_GROUPS|GROUP_LABELS)\b/;
const ID = "[\"'`](?:cyber|cosmic|cozy)[\"'`]";
// A family id in a comparison, a switch case, or a membership test (`x.includes("cyber")`, `["cyber"].includes(x)`).
const COMPARES = new RegExp(
  [
    `[!=]==?\\s*${ID}`,
    `${ID}\\s*[!=]==?`,
    `\\bcase\\s+${ID}`,
    `\\.(?:includes|has|indexOf)\\(\\s*${ID}`,
    `\\[[^\\]]*${ID}[^\\]]*\\]\\s*\\.(?:includes|indexOf|some)\\(`,
  ].join("|"),
);

describe("catalog bypass", () => {
  it("scans the component sources", () => {
    expect(Object.keys(SOURCES).length).toBeGreaterThan(100);
  });

  it("keeps the full kind and family lists out of every component", () => {
    const offenders = Object.entries(SOURCES)
      .filter(([path]) => !/\.test\.tsx?$/.test(path))
      .filter(([, source]) => FULL_ORDER.test(source))
      .map(([path]) => path);
    expect(offenders).toEqual([]);
  });

  // A family's temperament is data in the registry. A component that names a family id to decide a
  // mark or a warning would drift from it.
  it("keeps family ids out of component comparisons", () => {
    const offenders = Object.entries(SOURCES)
      .filter(([path]) => !/\.test\.tsx?$/.test(path))
      .filter(([, source]) => COMPARES.test(source))
      .map(([path]) => path);
    expect(offenders).toEqual([]);
  });

  it("recognises a family-id comparison", () => {
    expect(COMPARES.test('if (id === "cyber") {}')).toBe(true);
    expect(COMPARES.test("return 'cozy' !== group;")).toBe(true);
    expect(COMPARES.test('id === "classic"')).toBe(false);
  });

  it("recognises a family id in a switch case or a membership test", () => {
    expect(COMPARES.test('switch (id) { case "cyber": return 1; }')).toBe(true);
    expect(COMPARES.test('return groups.includes("cosmic");')).toBe(true);
    expect(COMPARES.test('return ["cyber", "cosmic"].includes(id);')).toBe(true);
    expect(COMPARES.test("return set.has('cozy');")).toBe(true);
    expect(COMPARES.test('switch (id) { case "classic": return 1; }')).toBe(false);
    expect(COMPARES.test('return groups.includes("dots");')).toBe(false);
  });
});
