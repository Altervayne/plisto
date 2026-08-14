// -- Component Imports --
import { CenteredStage } from "../common/CenteredStage";
import { QuietButton } from "../common/QuietButton";
import { ProgressLine } from "./ProgressLine";
import { ScanCounters } from "./ScanCounters";

// -- State Imports --
import { useCancelScan, useScanProgress, useWorkspace } from "../../state/store";

// -- i18n Imports --
import { useT } from "../../i18n";

// -- Style Imports --
import styles from "./ScanProgress.module.css";

/**
 * The running-scan view. Determinate once the total is known (the reading pass); an indeterminate
 * sweep while the folder is still being walked. The progress fill is the single accent here.
 */
export function ScanProgress() {
  const workspace = useWorkspace();
  const progress = useScanProgress();
  const cancel = useCancelScan();
  const t = useT();

  const total = progress?.total ?? 0;
  const scanned = progress?.scanned ?? 0;
  const errors = progress?.errors ?? 0;
  const value = total > 0 ? scanned / total : null;

  return (
    <CenteredStage>
      <div className={styles.body}>
        <h1 className={styles.title}>{t((d) => d.scan.scanningTitle)}</h1>
        {workspace ? <p className={styles.path}>{workspace}</p> : null}
        <ProgressLine value={value} />
        <ScanCounters scanned={scanned} total={total} errors={errors} />
        <div className={styles.cancel}>
          <QuietButton onClick={() => void cancel()}>{t((d) => d.common.cancel)}</QuietButton>
        </div>
      </div>
    </CenteredStage>
  );
}
