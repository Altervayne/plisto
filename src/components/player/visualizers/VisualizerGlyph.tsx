// -- Local Imports --
import { VISUALIZER_VIEWS } from "./visualizerViews";

// -- State Imports --
import { isVisualizerKind } from "../../../state/player/visualizerRegistry";

// -- Type Imports --
import type { VisualizerKind } from "../../../state/player/visualizerKind";

/** A visualizer's glyph for the picker rows, stroked in the current color. A plugin kind draws an empty frame. */
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
      {isVisualizerKind(kind) ? VISUALIZER_VIEWS[kind].glyph : null}
    </svg>
  );
}
