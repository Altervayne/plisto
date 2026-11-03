// -- Component Imports --
import { QuietButton } from "../common/QuietButton";

// -- Local Imports --
import { retryable, stepLine } from "./locateCopy";

// -- i18n Imports --
import { useT } from "../../i18n";

// -- Type Imports --
import type { LocateStep } from "./locateFlow";

// -- Style Imports --
import styles from "./LocatePanel.module.css";

/**
 * The inline step line under a folder row: what the Locate flow is doing or asking, with the choices
 * that fit the step. Checking offers Cancel; a confirm offers the use action and Cancel; a refusal that
 * a retry can change offers Try again; a refusal or receipt closes with Dismiss. The running step is
 * silent, since the blocking overlay speaks for it.
 */
export function LocatePanel({
  step,
  onConfirm,
  onRetry,
  onDismiss,
}: {
  step: LocateStep;
  onConfirm: () => void;
  onRetry: () => void;
  onDismiss: () => void;
}) {
  const t = useT();
  const line = stepLine(t, step);
  if (line == null) return null;

  return (
    <div className={styles.panel} role="status">
      <span className={styles.line}>{line}</span>
      {step.kind === "confirm" ? (
        <QuietButton onClick={onConfirm}>
          {step.plan.kind === "merge"
            ? t((d) => d.settings.mergeAction)
            : t((d) => d.settings.locateUse)}
        </QuietButton>
      ) : null}
      {step.kind === "refused" && retryable(step.reason) ? (
        <QuietButton onClick={onRetry}>{t((d) => d.scan.tryAgain)}</QuietButton>
      ) : null}
      {step.kind === "checking" || step.kind === "confirm" ? (
        <QuietButton onClick={onDismiss}>{t((d) => d.common.cancel)}</QuietButton>
      ) : (
        <QuietButton onClick={onDismiss}>{t((d) => d.common.dismiss)}</QuietButton>
      )}
    </div>
  );
}
