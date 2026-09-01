// -- Icon Imports --
import { ScanLine } from "lucide-react";

// -- Component Imports --
import { QuietButton } from "../common/QuietButton";
import { NumberField } from "./NumberField";

// -- i18n Imports --
import { useT } from "../../i18n";

// -- Style Imports --
import styles from "./CropControls.module.css";

/** The dB floor a threshold can sit on, and the ceiling on the lead-in padding. */
const THRESHOLD_MIN = -90;
const THRESHOLD_MAX = 0;
const PADDING_MIN = 0;
const PADDING_MAX = 2_000;

/**
 * The cropper's two knobs: the silence threshold and the lead-in padding, each a field that reads as
 * text. Changing the threshold re-detects the trim; changing the padding widens the kept region live.
 * Once a handle is hand-moved the threshold no longer re-detects, so a Re-detect button surfaces to opt
 * back in - clicking it drops the hand-moved hold and detects again at the current threshold.
 */
export function CropControls({
  thresholdDb,
  paddingMs,
  handMoved,
  onThreshold,
  onPadding,
  onRedetect,
}: {
  thresholdDb: number;
  paddingMs: number;
  handMoved: boolean;
  onThreshold: (db: number) => void;
  onPadding: (ms: number) => void;
  onRedetect: () => void;
}) {
  const t = useT();

  return (
    <div className={styles.controls}>
      <div className={styles.knob}>
        <span className={styles.label}>{t((d) => d.splice.threshold)}</span>
        <NumberField
          value={thresholdDb}
          min={THRESHOLD_MIN}
          max={THRESHOLD_MAX}
          suffix="dB"
          onCommit={onThreshold}
          ariaLabel={t((d) => d.splice.threshold)}
        />
      </div>
      <div className={styles.knob}>
        <span className={styles.label}>{t((d) => d.splice.padding)}</span>
        <NumberField
          value={paddingMs}
          min={PADDING_MIN}
          max={PADDING_MAX}
          suffix="ms"
          onCommit={onPadding}
          ariaLabel={t((d) => d.splice.padding)}
        />
      </div>
      {handMoved ? (
        <QuietButton onClick={onRedetect}>
          <ScanLine size={15} strokeWidth={1.8} />
          <span>{t((d) => d.splice.redetect)}</span>
        </QuietButton>
      ) : null}
    </div>
  );
}
