// -- Component Imports --
import { CenteredStage } from "../common/CenteredStage";
import { QuietButton } from "../common/QuietButton";
import { Tooltip } from "../common/Tooltip/Tooltip";
import { ProgressLine } from "../scan/ProgressLine";
import { StaffSpinner } from "../scan/StaffSpinner";
import { SpliceRunReport } from "./SpliceRunReport";

// -- IPC Imports --
import { spliceCancel } from "../../lib/ipc";

// -- Utils Imports --
import { openFolder } from "../../lib/opener";

// -- Type Imports --
import type { SpliceProgress, SpliceReport } from "../../types";
import type { AddState } from "./useTrimSaveAsNew";

// -- i18n Imports --
import { useT } from "../../i18n";

// -- Style Imports --
import styles from "./TrimStage.module.css";

/** The new-file save running: a determinate stage over the destination, with Cancel. */
export function TrimNewRunning({
  destination,
  progress,
}: {
  destination: string | null;
  progress: SpliceProgress | null;
}) {
  const t = useT();
  const total = progress?.total ?? 1;
  const completed = progress?.completed ?? 0;
  const errors = progress?.errors ?? 0;
  const value = total > 0 ? completed / total : null;
  return (
    <CenteredStage>
      <div className={styles.centered}>
        <StaffSpinner />
        <h1 className={styles.title}>{t((d) => d.splice.trimming)}</h1>
        {destination ? (
          <Tooltip label={destination}>
            <p className={styles.path}>{destination}</p>
          </Tooltip>
        ) : null}
        <ProgressLine value={value} />
        <div className={`${styles.counters} tabular`}>
          <span>
            {completed} / {total}
          </span>
          {errors > 0 ? (
            <span className={styles.tally}>{t((d) => d.export.errors, { n: errors })}</span>
          ) : null}
        </div>
        <div className={styles.foot}>
          <QuietButton onClick={() => void spliceCancel()}>{t((d) => d.splice.cancel)}</QuietButton>
        </div>
      </div>
    </CenteredStage>
  );
}

/**
 * The new-file save's report. The actions stay quiet - the good dot is the signal, no solid accent here.
 */
export function TrimNewDone({
  report,
  destination,
  addState,
  onAddToLibrary,
  onTrimAgain,
}: {
  report: SpliceReport;
  destination: string | null;
  addState: AddState;
  onAddToLibrary: () => void;
  onTrimAgain: () => void;
}) {
  const t = useT();
  const title = report.cancelled
    ? t((d) => d.splice.stopped, { done: report.written, total: report.total })
    : t((d) => d.splice.wrote, { n: report.written });
  const addLabel =
    addState === "adding"
      ? t((d) => d.splice.addingToLibrary)
      : addState === "added"
        ? t((d) => d.splice.addedToLibrary)
        : t((d) => d.splice.addToLibrary);
  return (
    <CenteredStage>
      <div className={styles.centered}>
        <span className={styles.dot} aria-hidden="true" />
        <h1 className={styles.title}>{title}</h1>
        <SpliceRunReport report={report} />
        <div className={styles.actions}>
          <QuietButton onClick={onAddToLibrary} disabled={report.written === 0 || addState !== "idle"}>
            {addLabel}
          </QuietButton>
          {destination ? (
            <QuietButton onClick={() => void openFolder(destination)}>
              {t((d) => d.export.openFolder)}
            </QuietButton>
          ) : null}
          <QuietButton onClick={onTrimAgain}>{t((d) => d.splice.trimAgain)}</QuietButton>
        </div>
      </div>
    </CenteredStage>
  );
}
