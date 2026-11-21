import { describe, expect, it } from "vitest";
import { blendModeFor, registryScene } from "./registryScene";
import { blendFor, VISUALIZER_DESCRIPTORS } from "../../../../state/player/visualizerRegistry";
import type { GlKind } from "../../../../state/player/visualizerKind";

const GL_KINDS = VISUALIZER_DESCRIPTORS.filter((d) => d.engine === "gl").map((d) => d.id as GlKind);
const OLD_INDEX = { screen: 0, multiply: 1, normal: 2 } as const;
const NEW_INDEX = { light: 0, ink: 1, image: 2 } as const;

describe("registryScene composite", () => {
  it("covers every built-in GL kind", () => {
    expect(GL_KINDS.length).toBeGreaterThan(0);
  });

  it.each(GL_KINDS)("%s keeps the renderer mode index in both themes", (kind) => {
    const { composite } = registryScene(kind).descriptor;
    for (const light of [true, false]) {
      const picked = light ? composite.light : composite.dark;
      expect(NEW_INDEX[picked]).toBe(OLD_INDEX[blendFor(kind, light)]);
    }
  });

  it.each(GL_KINDS)("%s re-exports the slot blend unchanged", (kind) => {
    for (const light of [true, false]) expect(blendModeFor(kind, light)).toBe(blendFor(kind, light));
  });
});
