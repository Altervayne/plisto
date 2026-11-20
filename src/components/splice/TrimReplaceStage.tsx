// -- Framework Imports --
import { useEffect, useId } from "react";

// -- Component Imports --
import { CenteredStage } from "../common/CenteredStage";
import { PrimaryButton } from "../common/PrimaryButton";
import { QuietButton } from "../common/QuietButton";
import { Tooltip } from "../common/Tooltip/Tooltip";
import { ProgressLine } from "../scan/ProgressLine";
import { StaffSpinner } from "../scan/StaffSpinner";
import { TrimUndoConfirm } from "./TrimReplaceDialogs";

// -- State Imports --
import { openKeptBackups } from "../../state/fileWrites/store";

// -- Utils Imports --
import { formatShortDate } from "../../lib/format";
import { trimFailureWords, undoFailureText } from "../../lib/trimFailureText";
import type { ReachBlock } from "../../lib/trimReplace";

// -- Type Imports --
import type { TrimReplaceFlow } from "./useTrimReplaceFlow";

// -- i18n Imports --
import { useLocale, useT } from "../../i18n";

// -- Style Imports --
import styles from "./TrimStage.module.css";

/**
 * The replace's centered screens: the run, its receipt with Undo trim and its confirm, the receipt of an
 * undo, and a failure with Retry. `reloading` holds the receipts' actions while the analysis rereads
 * the file after a finished write; once it ends, the receipt's primary action takes focus. A failure
 * never rereads, so its actions mount enabled and take focus.
 */
export function TrimReplaceStage({
  replace,
  path,
  name,
  reloading,
}: {
  replace: TrimReplaceFlow;
  path: string;
  name: string;
  reloading: boolean;
}) {
  const t = useT();
  const locale = useLocale();
  const { flow, snapshot, progress } = replace;
  const primaryId = useId();
  const receipt = flow.kind === "done" || flow.kind === "undone";
  useEffect(() => {
    if (receipt && !reloading) document.getElementById(primaryId)?.focus();
  }, [receipt, reloading, primaryId]);
  if (!snapshot || flow.kind === "idle" || flow.kind === "confirming") return null;

  if (flow.kind === "running") {
    const total = progress?.total ?? 0;
    const value = total > 0 ? (progress?.completed ?? 0) / total : null;
    return (
      <CenteredStage>
        <div className={styles.centered}>
          <StaffSpinner />
          <h1 className={styles.title}>{t((d) => d.fileWrites.trim.runningTitle)}</h1>
          <Tooltip label={path}>
            <p className={styles.path}>{path}</p>
          </Tooltip>
          <p className={styles.line}>{t((d) => d.fileWrites.trim.runningLine)}</p>
          <ProgressLine value={value} />
          <div className={styles.foot}>
            <QuietButton onClick={replace.cancel} autoFocus>
              {t((d) => d.fileWrites.cancel)}
            </QuietButton>
          </div>
        </div>
      </CenteredStage>
    );
  }

  if (flow.kind === "done") {
    const { expiresAt } = flow.result;
    const until =
      expiresAt == null
        ? t((d) => d.fileWrites.trim.keepUntilForever)
        : t((d) => d.fileWrites.trim.keepUntil, { date: formatShortDate(expiresAt / 1000, locale) });
    return (
      <CenteredStage>
        <TrimUndoConfirm
          open={flow.undo === "confirming"}
          name={name}
          snapshot={snapshot}
          onConfirm={replace.undo}
          onClose={replace.dismissUndo}
        />
        <div className={styles.centered}>
          <span className={styles.dot} aria-hidden="true" />
          <h1 className={styles.title}>{t((d) => d.fileWrites.trim.doneTitle)}</h1>
          <p className={styles.line}>
            {t((d) => d.fileWrites.trim.doneLine, {
              name,
              to: snapshot.to,
              from: snapshot.from,
              size: snapshot.size,
              until,
            })}
          </p>
          <p className={`${styles.line} ${styles.dim}`}>{t((d) => d.fileWrites.trim.doneRestart)}</p>
          {flow.undoFailure ? (
            <p className={styles.warn}>{undoFailureText(t, flow.undoFailure, path, snapshot.size)}</p>
          ) : null}
          <div className={styles.actions}>
            {replace.undoAvailable ? (
              <QuietButton onClick={replace.askUndo} disabled={reloading || flow.undo !== "idle"}>
                {t((d) => d.fileWrites.trim.undoTrim)}
              </QuietButton>
            ) : null}
            <QuietButton onClick={openKeptBackups}>{t((d) => d.fileWrites.trim.keptBackups)}</QuietButton>
            <PrimaryButton id={primaryId} onClick={replace.reset} disabled={reloading || flow.undo === "running"}>
              {t((d) => d.fileWrites.trim.trimAnother)}
            </PrimaryButton>
          </div>
        </div>
      </CenteredStage>
    );
  }

  if (flow.kind === "undone") {
    return (
      <CenteredStage>
        <div className={styles.centered}>
          <span className={styles.dot} aria-hidden="true" />
          <h1 className={styles.title}>{t((d) => d.fileWrites.trim.undoneTitle)}</h1>
          <p className={styles.line}>{t((d) => d.fileWrites.trim.undoneLine, { name, from: snapshot.from })}</p>
          <div className={styles.actions}>
            <PrimaryButton id={primaryId} onClick={replace.reset} disabled={reloading}>
              {t((d) => d.fileWrites.trim.trimAgain)}
            </PrimaryButton>
          </div>
        </div>
      </CenteredStage>
    );
  }

  // A changed file needs a fresh trim, and an unavailable one can only be saved aside; neither retries.
  const words = trimFailureWords(t, flow.failure, path, snapshot.size);
  const retryable = flow.failure.kind !== "changed" && flow.failure.kind !== "unavailable";
  return (
    <CenteredStage>
      <div className={styles.centered}>
        <span className={`${styles.dot} ${styles.dotBad}`} aria-hidden="true" />
        <h1 className={styles.title}>{t((d) => d.fileWrites.trim.failedTitle)}</h1>
        <p className={styles.line}>
          {words.title ? <b>{words.title}.</b> : null}
          {words.title ? " " : null}
          {t((d) => d.fileWrites.trim.untouched)}
        </p>
        {words.text ? <p className={styles.line}>{words.text}</p> : null}
        <div className={styles.actions}>
          {retryable ? (
            <PrimaryButton onClick={replace.run} autoFocus>
              {t((d) => d.fileWrites.retry)}
            </PrimaryButton>
          ) : null}
          {flow.failure.kind === "changed" ? (
            <PrimaryButton onClick={replace.trimAgain} autoFocus>
              {t((d) => d.fileWrites.trim.trimAgain)}
            </PrimaryButton>
          ) : null}
          <QuietButton onClick={replace.reset} autoFocus={flow.failure.kind === "unavailable"}>
            {t((d) => d.fileWrites.trim.saveAsNew)}
          </QuietButton>
        </div>
      </div>
    </CenteredStage>
  );
}

/**
 * The trim workbench when the file is out of reach: gone from disk, or on an offline folder. Nothing can
 * be trimmed or replaced, so the only way is back to the Track Editor.
 */
export function TrimUnavailable({ block, onBack }: { block: ReachBlock; onBack: () => void }) {
  const t = useT();
  return (
    <CenteredStage>
      <div className={styles.centered}>
        <span className={`${styles.dot} ${styles.dotWarn}`} aria-hidden="true" />
        <h1 className={styles.title}>{t((d) => d.fileWrites.trim.unavailableTitle)}</h1>
        <p className={styles.line}>
          {block.kind === "offline"
            ? t((d) => d.fileWrites.trim.offlineLine, { folder: block.folder })
            : t((d) => d.fileWrites.trim.missingLine)}
        </p>
        <div className={styles.actions}>
          <PrimaryButton onClick={onBack}>{t((d) => d.fileWrites.trim.backToEditor)}</PrimaryButton>
        </div>
      </div>
    </CenteredStage>
  );
}
