// -- Icon Imports --
import { Info } from "lucide-react";

// -- Component Imports --
import { StampBanner, StampBigLine, StampCounters } from "./StampRows";

// -- Utils Imports --
import type { RunProgress } from "../../lib/stampFlow";

// -- i18n Imports --
import { useT } from "../../i18n";

// -- Style Imports --
import styles from "./StampRunning.module.css";

/**
 * The body of a running write or undo: which file of how many, the bar, the path in hand and the tallies.
 * It holds no file list, so a file event re-renders only these few lines.
 */
export function StampRunning({ run, current }: { run: RunProgress; current: string | null }) {
  const t = useT();
  const undo = run.mode === "undo";
  const at = Math.min(run.done + 1, Math.max(run.total, 1));
  const percent = run.total > 0 ? Math.min(100, (run.done / run.total) * 100) : 0;
  return (
    <>
      <StampBigLine>
        {undo
          ? t((d) => d.fileWrites.run.undoProgress, { i: at, n: run.total })
          : t((d) => d.fileWrites.run.progress, { i: at, n: run.total })}
      </StampBigLine>
      <div className={styles.bar} role="progressbar" aria-valuemin={0} aria-valuemax={run.total} aria-valuenow={run.done}>
        <i className={styles.fill} style={{ width: `${percent}%` }} />
      </div>
      <span className={styles.current}>{current}</span>
      <StampCounters written={run.written} skipped={run.skipped} failed={run.failed} />
      {undo ? null : (
        <StampBanner icon={<Info size={16} strokeWidth={1.8} aria-hidden="true" />}>
          {t((d) => d.fileWrites.run.infoRunning)}
        </StampBanner>
      )}
    </>
  );
}
