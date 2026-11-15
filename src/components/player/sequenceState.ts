/*
 * The repeat cycle the sequencing toggle and the pop-out widget step through. Split out so it is testable
 * apart from the DOM.
 */

// -- Type Imports --
import type { RepeatMode } from "../../types";

/** The next repeat mode a single toggle steps to, cycling off -> all -> one -> off. */
export function nextRepeat(mode: RepeatMode): RepeatMode {
  if (mode === "off") return "all";
  if (mode === "all") return "one";
  return "off";
}
