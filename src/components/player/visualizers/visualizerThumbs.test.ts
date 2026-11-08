// -- Test Imports --
import { describe, expect, it } from "vitest";

// -- State Imports --
import { VISUALIZER_DESCRIPTORS } from "../../../state/player/visualizerRegistry";

const FILES = import.meta.glob<string>("../../../assets/visualizer-thumbs/*.webp", {
  eager: true,
  query: "?url",
  import: "default",
});
const MANIFEST = import.meta.glob<Record<string, string>>("../../../assets/visualizer-thumbs/manifest.json", {
  eager: true,
  import: "default",
});

describe("visualizer thumbnails", () => {
  it("has a light and a dark still for every kind", () => {
    const missing: string[] = [];
    for (const { id } of VISUALIZER_DESCRIPTORS) {
      for (const theme of ["light", "dark"]) {
        if (!FILES[`../../../assets/visualizer-thumbs/${id}-${theme}.webp`]) missing.push(`${id}-${theme}`);
      }
    }
    expect(missing).toEqual([]);
  });

  it("lists a source hash for every kind", () => {
    const manifest = Object.values(MANIFEST)[0] ?? {};
    for (const { id } of VISUALIZER_DESCRIPTORS) expect(manifest[id]).toMatch(/^[0-9a-f]{64}$/);
  });
});
