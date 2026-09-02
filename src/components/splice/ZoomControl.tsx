// -- Icon Imports --
import { Minus, Plus } from "lucide-react";

// -- Component Imports --
import { IconButton } from "../common/IconButton";
import { QuietButton } from "../common/QuietButton";

// -- Local Imports --
import { formatVisible } from "./zoomModel";

// -- Type Imports --
import type { ZoomState } from "./WaveformLane";

// -- i18n Imports --
import { useT } from "../../i18n";

// -- Style Imports --
import styles from "./ZoomControl.module.css";

/**
 * The waveform zoom: a minus and a plus around a fit readout. The buttons step the scale toward the
 * playhead and disable at the bounds; the readout shows Fit at the low end, else the visible span, and
 * clicking it returns to fit. All quiet ink, off the accent.
 */
export function ZoomControl({
  state,
  onZoomIn,
  onZoomOut,
  onFit,
}: {
  state: ZoomState;
  onZoomIn: () => void;
  onZoomOut: () => void;
  onFit: () => void;
}) {
  const t = useT();
  const readout = state.atFit ? t((d) => d.splice.zoomFit) : formatVisible(state.secondsVisible);
  return (
    <div className={styles.zoom} role="group" aria-label={t((d) => d.splice.zoomLabel)}>
      <IconButton aria-label={t((d) => d.splice.zoomOut)} onClick={onZoomOut} disabled={!state.canOut}>
        <Minus size={15} strokeWidth={1.8} />
      </IconButton>
      <QuietButton
        aria-label={t((d) => d.splice.zoomFitTo)}
        title={t((d) => d.splice.zoomFitTo)}
        onClick={onFit}
        disabled={state.atFit}
      >
        <span className={`${styles.readout} tabular`}>{readout}</span>
      </QuietButton>
      <IconButton aria-label={t((d) => d.splice.zoomIn)} onClick={onZoomIn} disabled={!state.canIn}>
        <Plus size={15} strokeWidth={1.8} />
      </IconButton>
    </div>
  );
}
