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
});
