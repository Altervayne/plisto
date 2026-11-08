// -- Local Imports --
import { VISUALIZER_VIEWS } from "./visualizerViews";

// -- Type Imports --
import type { VisualizerKind } from "../../../state/player/visualizerKind";

/** A visualizer's glyph for the picker rows, stroked in the current color. */
export function VisualizerGlyph({ kind, size = 16 }: { kind: VisualizerKind; size?: number }) {
  return (
    <svg
      width={size}
      height={size}
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.8}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden="true"
    >
      {VISUALIZER_VIEWS[kind].glyph}
    </svg>
  );
}
