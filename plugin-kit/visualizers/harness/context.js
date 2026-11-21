/*
 * The harness's side of the frame's VisContext: the layout presets, the two themes' stage colors, the init
 * message for a kind, and the tracker that finds which context fields changed so an `update` carries only
 * those. Pure, so it runs in the page and in node tests.
 */

// -- Local Imports --
import { VIS_API, VIS_INIT_TYPE } from "../lib/protocol.js";

/** Three sRGB colors from a sunset-like cover, as the runtime takes a palette: 9 numbers in 0..1. */
export const PALETTE = [224, 100, 79, 42, 138, 160, 246, 201, 138].map((v) => v / 255);

export const THEMES = {
  dark: { ground: [0.063, 0.071, 0.086], backing: [0.09, 0.098, 0.118], ink: [0.93, 0.94, 0.96] },
  light: { ground: [0.957, 0.961, 0.969], backing: [0.929, 0.933, 0.945], ink: [0.09, 0.1, 0.12] },
};

/** The stage and cover geometry per preset, in CSS pixels. `ambient` presets draw behind the whole app. */
export const LAYOUTS = {
  player: {
    label: "Player",
    ambient: false,
    layout: {
      width: 1000,
      height: 680,
      cover: [330, 90, 340, 340],
      radius: 16,
      mask: [160, 40, 680, 480],
      floor: 600,
      hush: [
        [300, 450, 400, 28],
        [320, 484, 360, 20],
      ],
    },
  },
  ambient: {
    label: "Ambient",
    ambient: true,
    layout: {
      width: 1000,
      height: 680,
      cover: [330, 90, 340, 340],
      radius: 16,
      mask: null,
      floor: null,
      hush: [],
    },
  },
  compact: {
    label: "Compact",
    ambient: false,
    layout: {
      width: 640,
      height: 420,
      cover: [220, 40, 200, 200],
      radius: 12,
      mask: [100, 10, 440, 300],
      floor: 360,
      hush: [[180, 260, 280, 24]],
    },
  },
  portrait: {
    label: "Portrait",
    ambient: false,
    layout: {
      width: 420,
      height: 720,
      cover: [40, 60, 340, 340],
      radius: 16,
      mask: [10, 20, 400, 460],
      floor: 640,
      hush: [
        [40, 420, 340, 28],
        [60, 454, 300, 20],
      ],
    },
  },
};

export const REACTIVITIES = ["calm", "balanced", "lively"];

/** A dark-only kind draws dark in a light theme, so its stage stays dark too. */
export const stageTheme = (decl, theme) => (decl.darkOnly ? "dark" : theme);

/** The default value of each setting a kind declares, by setting id. */
export function defaultSettings(decl) {
  const settings = {};
  for (const s of decl.settings) settings[s.id] = s.default;
  return settings;
}

const cloneRect = (rect) => (rect ? [...rect] : null);

/** The VisContext for a kind under the controls' current state. `cover` is the bitmap or null. */
export function buildContext(decl, controls, cover) {
  const preset = LAYOUTS[controls.layout] ?? LAYOUTS.player;
  const { layout } = preset;
  const theme = stageTheme(decl, controls.theme);
  const { ground, backing, ink } = THEMES[theme];
  return {
    layout: {
      ...layout,
      cover: [...layout.cover],
      mask: cloneRect(layout.mask),
      hush: layout.hush.map(cloneRect),
    },
    palette: Float32Array.from(PALETTE),
    cover: decl.needs.cover ? cover : null,
    colors: { ground: [...ground], backing: [...backing], ink: [...ink] },
    light: theme === "light",
    reactivity: controls.reactivity,
    ambient: preset.ambient,
    reducedMotion: controls.reducedMotion,
    settings: { ...controls.settings },
  };
}

/** The `plisto:vis-init` message for a kind; the port travels beside it in the transfer list. */
export function buildInit(decl, context, meter) {
  return {
    plisto: 1,
    type: VIS_INIT_TYPE,
    api: VIS_API,
    kind: decl.id,
    composite: { light: decl.look.light.composite, dark: decl.look.dark.composite },
    fillsStage: decl.fillsStage,
    needs: decl.needs,
    settingShapes: decl.settings.map((s) => ({
      id: s.id,
      type: s.type,
      ...(s.type === "choice" && { options: s.options.map((o) => o.id) }),
    })),
    meter,
    context,
  };
}

/** The CSS blend the slot gets: the kind's own blend for the theme it draws in. */
export const blendOf = (decl, theme) => decl.look[stageTheme(decl, theme)].blend;

// -- Change tracking --

const rectEq = (a, b) => a === b || (a !== null && b !== null && a.every((v, i) => v === b[i]));
const listEq = (a, b) => a.length === b.length && Array.prototype.every.call(a, (v, i) => v === b[i]);

function layoutEq(a, b) {
  return (
    a.width === b.width &&
    a.height === b.height &&
    a.radius === b.radius &&
    a.floor === b.floor &&
    rectEq(a.cover, b.cover) &&
    rectEq(a.mask, b.mask) &&
    a.hush.length === b.hush.length &&
    a.hush.every((rect, i) => rectEq(rect, b.hush[i]))
  );
}

function settingsEq(a, b) {
  const keys = Object.keys(a);
  return keys.length === Object.keys(b).length && keys.every((k) => k in b && a[k] === b[k]);
}

const colorsEq = (a, b) => ["ground", "backing", "ink"].every((k) => listEq(a[k], b[k]));

/** The tracker keeps its own copy of what it last reported, so a caller may rebuild or mutate freely. */
export function createContextTracker(initial) {
  const snapshot = (c) => ({
    ...c,
    layout: {
      ...c.layout,
      cover: [...c.layout.cover],
      mask: cloneRect(c.layout.mask),
      hush: c.layout.hush.map(cloneRect),
    },
    palette: c.palette.slice(),
    colors: { ground: [...c.colors.ground], backing: [...c.colors.backing], ink: [...c.colors.ink] },
    settings: { ...c.settings },
  });
  let last = snapshot(initial);
  return {
    /** The fields of `next` that differ from the last reported context, or null when none do. */
    diff(next) {
      const changed = {};
      const differs = {
        layout: !layoutEq(last.layout, next.layout),
        palette: !listEq(last.palette, next.palette),
        cover: last.cover !== next.cover,
        colors: !colorsEq(last.colors, next.colors),
        light: last.light !== next.light,
        reactivity: last.reactivity !== next.reactivity,
        ambient: last.ambient !== next.ambient,
        reducedMotion: last.reducedMotion !== next.reducedMotion,
        settings: !settingsEq(last.settings, next.settings),
      };
      for (const key of Object.keys(differs)) if (differs[key]) changed[key] = next[key];
      if (Object.keys(changed).length === 0) return null;
      last = snapshot(next);
      return changed;
    },
  };
}
