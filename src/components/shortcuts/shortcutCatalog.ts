/*
 * The shortcuts as people read them: each one's key combination, grouped for the shortcuts sheet, plus
 * the localized text the transport tooltips borrow. Named keys localize; letters and glyphs print as is.
 */

// -- Type Imports --
import type { Dict } from "../../i18n/en";
import type { Translate } from "../../i18n";

/** A key with a localized name. */
type NamedKey = keyof Dict["shortcuts"]["keys"];

/** One key cap: a named key, or a letter or glyph printed as is. */
export type KeyCap = NamedKey | "K" | "F" | "A" | "Z" | "Y" | "?";

/** The keys held together for one shortcut, in press order. */
export type Combo = readonly KeyCap[];

const NAMED: readonly NamedKey[] = ["ctrl", "shift", "space", "esc", "right", "left", "up", "down"];

function isNamed(cap: KeyCap): cap is NamedKey {
  return (NAMED as readonly string[]).includes(cap);
}

export const COMBOS = {
  togglePlay: ["space"],
  next: ["ctrl", "right"],
  prev: ["ctrl", "left"],
  seekForward: ["shift", "right"],
  seekBack: ["shift", "left"],
  volumeUp: ["ctrl", "up"],
  volumeDown: ["ctrl", "down"],
  finder: ["ctrl", "K"],
  find: ["ctrl", "F"],
  back: ["esc"],
  shortcuts: ["?"],
  selectAll: ["ctrl", "A"],
  undo: ["ctrl", "Z"],
  redo: ["ctrl", "Y"],
} as const satisfies Record<string, Combo>;

/** One sheet row: what the shortcut does and its keys. */
export interface ShortcutRow {
  label: (d: Dict) => string;
  combo: Combo;
}

/** One sheet group. `playback` groups hide while the player is off, as their keys do nothing then. */
export interface ShortcutGroup {
  id: "playback" | "navigation" | "editing";
  label: (d: Dict) => string;
  rows: ShortcutRow[];
}

export const SHORTCUT_GROUPS: readonly ShortcutGroup[] = [
  {
    id: "playback",
    label: (d) => d.shortcuts.playback,
    rows: [
      { label: (d) => d.shortcuts.playPause, combo: COMBOS.togglePlay },
      { label: (d) => d.shortcuts.nextTrack, combo: COMBOS.next },
      { label: (d) => d.shortcuts.previousTrack, combo: COMBOS.prev },
      { label: (d) => d.shortcuts.forward, combo: COMBOS.seekForward },
      { label: (d) => d.shortcuts.back, combo: COMBOS.seekBack },
      { label: (d) => d.shortcuts.volumeUp, combo: COMBOS.volumeUp },
      { label: (d) => d.shortcuts.volumeDown, combo: COMBOS.volumeDown },
    ],
  },
  {
    id: "navigation",
    label: (d) => d.shortcuts.navigation,
    rows: [
      { label: (d) => d.shortcuts.findAnything, combo: COMBOS.finder },
      { label: (d) => d.shortcuts.searchView, combo: COMBOS.find },
      { label: (d) => d.shortcuts.goBack, combo: COMBOS.back },
      { label: (d) => d.shortcuts.showShortcuts, combo: COMBOS.shortcuts },
    ],
  },
  {
    id: "editing",
    label: (d) => d.shortcuts.editing,
    rows: [
      { label: (d) => d.shortcuts.selectAll, combo: COMBOS.selectAll },
      { label: (d) => d.common.undo, combo: COMBOS.undo },
      { label: (d) => d.common.redo, combo: COMBOS.redo },
    ],
  },
];

/** A key cap's printed text in the active locale. */
export function keyLabel(cap: KeyCap, t: Translate): string {
  return isNamed(cap) ? t((d) => d.shortcuts.keys[cap]) : cap;
}

/** A combination as one line of text, such as "Ctrl+Right". */
export function comboText(combo: Combo, t: Translate): string {
  return combo.map((cap) => keyLabel(cap, t)).join("+");
}

/** A control's label followed by its shortcuts, such as "Next track - Ctrl+Right". */
export function withShortcut(label: string, combos: readonly Combo[], t: Translate): string {
  return `${label} - ${combos.map((combo) => comboText(combo, t)).join(", ")}`;
}
