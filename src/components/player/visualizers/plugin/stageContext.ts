/*
 * The page side of a plugin frame's context: the stage geometry and the stage colors, measured the way the
 * built-in WebGL surface measures them, so a plugin kind draws around the same cover, mask and text.
 */

// -- Framework Imports --
import type { RefObject } from "react";

// -- State Imports --
import { sceneLight, type Reactivity } from "../../../../state/player/visualizerKind";
import type { KindValues } from "../../../../state/player/pluginVis/kindSettings";
import type { PluginVisualizerDescriptor } from "../../../../state/player/pluginVisualizers";

// -- Utils Imports --
import { isDarkTheme } from "../../../../theme";

// -- Type Imports --
import type { VisColors, VisContext, VisLayout, VisRect, VisRgb } from "../../../../visRuntime/protocol";

/** The stage elements a frame draws around. */
export interface StageRefs {
  coverRef: RefObject<HTMLElement | null>;
  maskRef?: RefObject<HTMLElement | null>;
  floorRef?: RefObject<HTMLElement | null>;
  hushRefs?: readonly RefObject<HTMLElement | null>[];
}

/** What a stage reads its context from, beyond its own slot. */
export interface StageInputs extends StageRefs {
  ambient: boolean;
  palette: Float32Array;
  pixels: ImageBitmap | null;
  reactivity: Reactivity;
}

// What a slot not yet in the page measures as.
const NO_LAYOUT: VisLayout = {
  width: 0,
  height: 0,
  cover: [0, 0, 1, 1],
  radius: 0,
  mask: null,
  floor: null,
  hush: [],
};
const NO_COLORS: VisColors = { ground: [0, 0, 0], backing: [0, 0, 0], ink: [1, 1, 1] };

/** Reads a color token as sRGB in 0..1, through the element's own computed color. */
function tokenRgb(el: HTMLElement, token: string): VisRgb {
  el.style.color = `var(${token})`;
  const m = getComputedStyle(el).color.match(/[\d.]+/g);
  return m && m.length >= 3 ? [Number(m[0]) / 255, Number(m[1]) / 255, Number(m[2]) / 255] : [0, 0, 0];
}

/** The stage geometry relative to `slot`, which fills the stage. */
export function measureLayout(slot: HTMLElement, refs: StageRefs): VisLayout {
  const stage = slot.getBoundingClientRect();
  const toStage = (b: DOMRect): VisRect => [b.left - stage.left, b.top - stage.top, b.width, b.height];
  const rel = (el: HTMLElement): VisRect => toStage(el.getBoundingClientRect());
  const cover = refs.coverRef.current;
  const mask = refs.maskRef?.current ?? null;
  const floor = refs.floorRef?.current ?? null;
  // A text block's box can span its column, so the hush takes the extent of the words inside it.
  const hush: VisRect[] = [];
  for (const ref of refs.hushRefs ?? []) {
    const el = ref.current;
    if (!el) continue;
    const words = document.createRange();
    words.selectNodeContents(el);
    const box = words.getBoundingClientRect();
    if (box.width > 0 && box.height > 0) hush.push(toStage(box));
  }
  return {
    width: stage.width,
    height: stage.height,
    cover: cover ? rel(cover) : [stage.width / 2, stage.height / 2, 1, 1],
    radius: cover ? parseFloat(getComputedStyle(cover).borderTopLeftRadius) || 0 : 0,
    mask: mask ? rel(mask) : null,
    floor: floor ? rel(floor)[1] : null,
    hush,
  };
}

/** The stage colors for a scene that draws `light`, on the ambient ground or the Player's. */
export function stageColors(slot: HTMLElement, light: boolean, ambient: boolean): VisColors {
  const colors = {
    ground: tokenRgb(slot, ambient ? "--bg" : "--surface"),
    backing: tokenRgb(slot, light ? "--surface-2" : "--sunken"),
    ink: tokenRgb(slot, "--ink"),
  };
  slot.style.color = "";
  return colors;
}

/** The context of a kind on the stage now; `slot` is null before it is in the page. */
export function readStageContext(
  slot: HTMLElement | null,
  inputs: StageInputs,
  descriptor: PluginVisualizerDescriptor,
  settings: KindValues,
  reducedMotion: boolean,
): VisContext {
  const light = sceneLight(descriptor.id, !isDarkTheme());
  return {
    layout: slot ? measureLayout(slot, inputs) : NO_LAYOUT,
    palette: inputs.palette,
    cover: descriptor.needs.cover ? inputs.pixels : null,
    colors: slot ? stageColors(slot, light, inputs.ambient) : NO_COLORS,
    light,
    reactivity: inputs.reactivity,
    ambient: inputs.ambient,
    reducedMotion,
    settings,
  };
}
