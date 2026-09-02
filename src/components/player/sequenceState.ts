/*
 * The sequencing button's read of the engine state. Repeat and shuffle are orthogonal, so one glyph
 * stands in for the pair: shuffle wins the icon when on, else the repeat mode picks it. The button reads
 * pressed whenever anything but plain forward play is set. Split out so it is testable apart from the DOM.
 */

// -- Type Imports --
import type { RepeatMode } from "../../types";

/** The glyph the button shows for the current pair: shuffle first, then the repeat mode. */
export type SequenceGlyph = "shuffle" | "repeat-one" | "repeat";

/** Picks the button's glyph from the pair. */
export function sequenceGlyph(repeat: RepeatMode, shuffle: boolean): SequenceGlyph {
  if (shuffle) return "shuffle";
  if (repeat === "one") return "repeat-one";
  return "repeat";
}

/** Whether a non-default mode is on: the button's raised-chip state. */
export function sequenceActive(repeat: RepeatMode, shuffle: boolean): boolean {
  return shuffle || repeat !== "off";
}

/** The next repeat mode a single toggle steps to, cycling off -> all -> one -> off. */
export function nextRepeat(mode: RepeatMode): RepeatMode {
  if (mode === "off") return "all";
  if (mode === "all") return "one";
  return "off";
}
