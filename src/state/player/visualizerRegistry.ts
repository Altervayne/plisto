/*
 * The visualizer registry: one descriptor per kind, holding what the app needs to know about it without
 * drawing it. Pure data, so the state layer and its tests read it with no UI or GL import; the label,
 * glyph and GL factory live in a second table keyed by the same ids, in the visualizers folder.
 */

/** The picker's labelled sections, in order. */
export const GROUP_ORDER = ["classic", "dots", "fluid"] as const;

export type VisualizerGroupId = (typeof GROUP_ORDER)[number];

/**
 * The CSS blend a kind's layer takes over the stage. The GL renderer composites screen, multiply or
 * normal; Ridge's Canvas 2D layer takes soft-light.
 */
export type BlendMode = "screen" | "multiply" | "normal" | "soft-light";

/** The blends the GL renderer can composite. */
export type GlBlendMode = Exclude<BlendMode, "soft-light">;

/** A pref a kind reads beyond the shared reactivity. */
export type VisualizerPref = "spectrumLayout";

export interface VisualizerDescriptor {
  id: string;
  group: VisualizerGroupId;
  engine: "gl" | "canvas2d";
  needs: {
    // The 128-band spectrum, which costs the engine a second analysis.
    fine: boolean;
    // The cover's own pixels as a texture.
    cover: boolean;
  };
  // Paints an opaque image across the whole stage, ignoring the Player's mask.
  fillsStage: boolean;
  blend: { light: BlendMode; dark: BlendMode };
  prefs?: readonly VisualizerPref[];
}

/** Every kind but Off, in picker and cycle order. */
export const VISUALIZER_DESCRIPTORS = [
  {
    id: "ridge",
    group: "classic",
    engine: "canvas2d",
    needs: { fine: false, cover: false },
    fillsStage: false,
    blend: { light: "soft-light", dark: "soft-light" },
  },
  {
    id: "terrain",
    group: "classic",
    engine: "gl",
    needs: { fine: true, cover: false },
    fillsStage: false,
    blend: { light: "multiply", dark: "screen" },
  },
  {
    id: "warp",
    group: "classic",
    engine: "gl",
    needs: { fine: false, cover: false },
    fillsStage: false,
    blend: { light: "multiply", dark: "screen" },
  },
  {
    id: "nebula",
    group: "classic",
    engine: "gl",
    needs: { fine: false, cover: false },
    fillsStage: false,
    blend: { light: "multiply", dark: "screen" },
  },
  {
    id: "bloom",
    group: "classic",
    engine: "gl",
    needs: { fine: false, cover: false },
    fillsStage: false,
    blend: { light: "multiply", dark: "screen" },
  },
  // The dot kinds paint their own ink on a light ground, so they composite straight there.
  {
    id: "halftone",
    group: "dots",
    engine: "gl",
    needs: { fine: false, cover: false },
    fillsStage: false,
    blend: { light: "normal", dark: "screen" },
  },
  {
    id: "dot-spectrum",
    group: "dots",
    engine: "gl",
    needs: { fine: true, cover: false },
    fillsStage: false,
    blend: { light: "normal", dark: "screen" },
    prefs: ["spectrumLayout"],
  },
  {
    id: "dot-cover",
    group: "dots",
    engine: "gl",
    needs: { fine: false, cover: true },
    fillsStage: false,
    blend: { light: "normal", dark: "normal" },
  },
  {
    id: "liquid",
    group: "fluid",
    engine: "gl",
    needs: { fine: false, cover: true },
    fillsStage: true,
    blend: { light: "normal", dark: "normal" },
  },
  {
    id: "ink",
    group: "fluid",
    engine: "gl",
    needs: { fine: false, cover: true },
    fillsStage: true,
    blend: { light: "normal", dark: "normal" },
  },
  {
    id: "mercury",
    group: "fluid",
    engine: "gl",
    needs: { fine: false, cover: true },
    fillsStage: true,
    blend: { light: "normal", dark: "normal" },
  },
  {
    id: "glass",
    group: "fluid",
    engine: "gl",
    needs: { fine: false, cover: true },
    fillsStage: true,
    blend: { light: "normal", dark: "normal" },
  },
  {
    id: "silk",
    group: "fluid",
    engine: "gl",
    needs: { fine: false, cover: false },
    fillsStage: true,
    blend: { light: "normal", dark: "normal" },
  },
] as const satisfies readonly VisualizerDescriptor[];

/** A kind the registry describes: every kind but Off. */
export type VisualizerId = (typeof VISUALIZER_DESCRIPTORS)[number]["id"];

/** The kinds drawn by the WebGL2 renderer. */
export type GlVisualizerId = Extract<(typeof VISUALIZER_DESCRIPTORS)[number], { engine: "gl" }>["id"];

const BY_ID = Object.fromEntries(VISUALIZER_DESCRIPTORS.map((d) => [d.id, d])) as Record<
  VisualizerId,
  VisualizerDescriptor
>;

export function descriptorOf(kind: VisualizerId): VisualizerDescriptor {
  return BY_ID[kind];
}

/** Whether a stored string names a kind, Off included. */
export function isVisualizerKind(raw: string | null | undefined): raw is VisualizerId | "off" {
  return raw === "off" || VISUALIZER_DESCRIPTORS.some((d) => d.id === raw);
}

/** The blend a kind's layer takes in a theme. A GL kind resolves to one the renderer composites. */
export function blendFor(kind: GlVisualizerId, light: boolean): GlBlendMode;
export function blendFor(kind: VisualizerId, light: boolean): BlendMode;
export function blendFor(kind: VisualizerId, light: boolean): BlendMode {
  const { blend } = descriptorOf(kind);
  return light ? blend.light : blend.dark;
}
