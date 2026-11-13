/*
 * How one frame wrapper presents itself, as pure code. Only the shown page frame covers the page's
 * slot and takes input; every other wrapper keeps a full-layer layout size, invisible, inert and out of
 * the accessibility tree. A frame is never moved in the DOM: showing and hiding change these values only.
 */

// -- Type Imports --
import type { FramePhase, FrameWant } from "../../../state/plugins/frameModel";

/** A box in the layer's own coordinates. */
export interface FrameRect {
  top: number;
  left: number;
  width: number;
  height: number;
}

export interface WrapperView {
  shown: boolean;
  /** Inline geometry: the slot's rect when shown, nothing otherwise (the stylesheet fills the layer). */
  style: FrameRect | undefined;
  /** The attributes a hidden wrapper carries so nothing in it can be reached. */
  inert: boolean;
  ariaHidden: boolean;
}

/**
 * The wrapper of `want` for its current phase. It is shown only when it is the active page, the frame
 * has answered (live, or not responding after having answered) and the slot's rect is known.
 */
export function wrapperView(
  want: Pick<FrameWant, "active">,
  phase: FramePhase | undefined,
  rect: FrameRect | null,
): WrapperView {
  const answered = phase === "live" || phase === "not_responding";
  const shown = want.active && answered && rect != null;
  return {
    shown,
    style: shown ? rect : undefined,
    inert: !shown,
    ariaHidden: !shown,
  };
}
