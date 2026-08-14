// -- Type Imports --
import type { ResizerControl } from "./resizerTypes";

// -- Style Imports --
import styles from "./Resizer.module.css";

/**
 * The grab handle on a region's edge: a quiet affordance on the continuous surface, transparent at
 * rest, a short bar surfacing on hover or focus. The vertical variant rides a right panel's left edge
 * (col-resize); the horizontal variant rides the folder band's bottom edge (row-resize). Presentational
 * only - the size state and the steering live in the hook; this wires the input and reflects the aria.
 */
export function Resizer({
  resizer,
  orientation = "vertical",
}: {
  resizer: ResizerControl;
  orientation?: "vertical" | "horizontal";
}) {
  return (
    <div
      className={styles.handle}
      data-orientation={orientation}
      role="separator"
      aria-orientation={orientation}
      aria-label={orientation === "vertical" ? "Resize panel" : "Resize folders"}
      tabIndex={0}
      aria-valuenow={resizer.valueNow}
      aria-valuemin={resizer.valueMin}
      aria-valuemax={resizer.valueMax}
      data-dragging={resizer.dragging ? "" : undefined}
      onPointerDown={resizer.onPointerDown}
      onPointerMove={resizer.onPointerMove}
      onPointerUp={resizer.onPointerUp}
      onPointerCancel={resizer.onPointerUp}
      onKeyDown={resizer.onKeyDown}
    >
      <span className={styles.bar} aria-hidden="true" />
    </div>
  );
}
