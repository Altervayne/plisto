/*
 * The visualizer choice: the persisted kinds, the order the ambient V key cycles them, the kind a
 * surface actually draws once its fallbacks apply, the reactivity level and the dot spectrum's layout.
 * Pure, so the pref reads, the cycle and the fallback are tested apart from the renderer.
 */

// -- State Imports --
import {
  GROUP_ORDER,
  VISUALIZER_DESCRIPTORS,
  descriptorOf,
  type GlVisualizerId,
  type VisualizerGroupId,
  type VisualizerId,
} from "./visualizerRegistry";

export type { VisualizerGroupId };

/**
 * The picker's labelled sections, in order. This is the one source of the visualizer order: the picker
 * renders it and the V cycle walks it, so they cannot drift. Ridge is the default.
 */
export const VISUALIZER_GROUPS: readonly { id: VisualizerGroupId; kinds: readonly VisualizerId[] }[] =
  GROUP_ORDER.map((id) => ({
    id,
    kinds: VISUALIZER_DESCRIPTORS.filter((d) => d.group === id).map((d) => d.id),
  }));

/** Off draws nothing; it closes the order after the sections and carries no label. */
export type VisualizerKind = VisualizerId | "off";

/** Every visualizer, in picker and cycle order. */
export const VISUALIZER_KINDS: readonly VisualizerKind[] = [
  ...VISUALIZER_GROUPS.flatMap((group): VisualizerKind[] => [...group.kinds]),
  "off",
];

/** The kinds drawn by the WebGL2 renderer; Ridge stays on Canvas 2D and Off draws nothing. */
export type GlKind = GlVisualizerId;

export const DEFAULT_VISUALIZER: VisualizerKind = "ridge";

/** Reads a stored pref value as a kind. Anything absent or unknown reads Ridge. */
export function normalizeVisualizerKind(raw: string | null | undefined): VisualizerKind {
  return (VISUALIZER_KINDS as readonly string[]).includes(raw ?? "")
    ? (raw as VisualizerKind)
    : DEFAULT_VISUALIZER;
}

/** The kind after `kind` in cycle order, wrapping from Off back to Ridge. */
export function nextVisualizerKind(kind: VisualizerKind): VisualizerKind {
  const i = VISUALIZER_KINDS.indexOf(kind);
  return VISUALIZER_KINDS[(Math.max(0, i) + 1) % VISUALIZER_KINDS.length];
}

export function isGlKind(kind: VisualizerKind): kind is GlKind {
  return kind !== "off" && descriptorOf(kind).engine === "gl";
}

/** Whether a kind draws from the 128-band spectrum, which costs the engine a second analysis. */
export function needsFineSpectrum(kind: VisualizerKind): boolean {
  return kind !== "off" && descriptorOf(kind).needs.fine;
}

/** Whether a kind draws the cover's own pixels, so it needs them on hand as a texture. */
export function needsCoverPixels(kind: VisualizerKind): boolean {
  return kind !== "off" && descriptorOf(kind).needs.cover;
}

/** Whether a kind paints an opaque image across the whole stage, so the Player's queue needs a backing. */
export function fillsStage(kind: VisualizerKind): boolean {
  return kind !== "off" && descriptorOf(kind).fillsStage;
}

/** What a surface can draw right now. */
export interface VisualizerSupport {
  // The WebGL2 renderer failed for the picked kind: no context, a lost context, or a shader error.
  glFailed: boolean;
  // The cover's pixels are on hand as a texture source.
  coverPixels: boolean;
}

/**
 * The kind a surface draws for a pick: a WebGL kind falls back to Ridge when the renderer failed, and a
 * kind that draws the cover's pixels falls back to Ridge without them, as it has no art to draw.
 */
export function effectiveVisualizerKind(
  picked: VisualizerKind,
  support: VisualizerSupport,
): VisualizerKind {
  if (!isGlKind(picked)) return picked;
  if (support.glFailed) return "ridge";
  if (needsCoverPixels(picked) && !support.coverPixels) return "ridge";
  return picked;
}

/** How hard the visualizers move with the music. Calm keeps only the slow eased motion. */
export const REACTIVITY_LEVELS = ["calm", "balanced", "lively"] as const;

export type Reactivity = (typeof REACTIVITY_LEVELS)[number];

export const DEFAULT_REACTIVITY: Reactivity = "balanced";

/** Reads a stored pref value as a reactivity level. Anything absent or unknown reads Balanced. */
export function normalizeReactivity(raw: string | null | undefined): Reactivity {
  return (REACTIVITY_LEVELS as readonly string[]).includes(raw ?? "") ? (raw as Reactivity) : DEFAULT_REACTIVITY;
}

/** How the dot spectrum lays out its columns: bass at the left, or bass in the centre mirrored outward. */
export const SPECTRUM_LAYOUTS = ["bass-left", "mirrored"] as const;

export type SpectrumLayout = (typeof SPECTRUM_LAYOUTS)[number];

export const DEFAULT_SPECTRUM_LAYOUT: SpectrumLayout = "bass-left";

/** Reads a stored pref value as a spectrum layout. Anything absent or unknown reads bass-left. */
export function normalizeSpectrumLayout(raw: string | null | undefined): SpectrumLayout {
  return (SPECTRUM_LAYOUTS as readonly string[]).includes(raw ?? "") ? (raw as SpectrumLayout) : DEFAULT_SPECTRUM_LAYOUT;
}
