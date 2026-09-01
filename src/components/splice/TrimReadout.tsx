// -- Icon Imports --
import { Play } from "lucide-react";

// -- Component Imports --
import { QuietButton } from "../common/QuietButton";
import { TimeField } from "./TimeField";

// -- Utils Imports --
import { formatDuration } from "../../lib/format";

// -- i18n Imports --
import { useT } from "../../i18n";

// -- Style Imports --
import styles from "./TrimReadout.module.css";

/**
 * The cropper's two-field readout: the head and tail trim times over the resulting duration, with the
 * play-kept audition beneath. The times are editable - typing a position moves the matching handle,
 * parsed and snapped. The duration is the kept length the cut writes, so it carries the padding the
 * trim points do not show. Digits align through tabular-nums.
 */
export function TrimReadout({
  inFrame,
  outFrame,
  resultSecs,
  sampleRate,
  onHead,
  onTail,
  onPlayKept,
}: {
  inFrame: number;
  outFrame: number;
  resultSecs: number;
  sampleRate: number;
  onHead: (frame: number) => void;
  onTail: (frame: number) => void;
  onPlayKept: () => void;
}) {
  const t = useT();

  return (
    <div className={styles.readout}>
      <div className={styles.row}>
        <span className={styles.label}>{t((d) => d.splice.head)}</span>
        <TimeField
          frame={inFrame}
          sampleRate={sampleRate}
          onCommit={onHead}
          ariaLabel={t((d) => d.splice.head)}
        />
      </div>
      <div className={styles.row}>
        <span className={styles.label}>{t((d) => d.splice.tail)}</span>
        <TimeField
          frame={outFrame}
          sampleRate={sampleRate}
          onCommit={onTail}
          ariaLabel={t((d) => d.splice.tail)}
        />
      </div>
      <div className={styles.row}>
        <span className={styles.label}>{t((d) => d.splice.result)}</span>
        <span className={`${styles.value} tabular`}>{formatDuration(resultSecs)}</span>
      </div>
      <QuietButton onClick={onPlayKept}>
        <Play size={15} strokeWidth={1.8} />
        <span>{t((d) => d.splice.playKept)}</span>
      </QuietButton>
    </div>
  );
}
