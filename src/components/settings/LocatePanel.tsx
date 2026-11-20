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
 * silent, since the blocking overlay speaks for it, unless the apply can be stopped (`onStop`): then it
 * names the folder being updated and offers Cancel. `locked` holds the use action and Try again while
 * another apply runs.
 */
export function LocatePanel({
  step,
  locked = false,
  onConfirm,
  onRetry,
  onDismiss,
  onStop,
}: {
  step: LocateStep;
  locked?: boolean;
  onConfirm: () => void;
  onRetry: () => void;
  onDismiss: () => void;
  onStop?: () => void;
}) {
  const t = useT();
  const stoppable = step.kind === "running" && onStop != null;
  const line = stoppable ? t((d) => d.gone.updating, { name: step.name }) : stepLine(t, step);
  if (line == null) return null;

  return (
    <div className={styles.panel} role="status">
      <span className={styles.line}>{line}</span>
      {step.kind === "confirm" ? (
        <QuietButton onClick={onConfirm} disabled={locked}>
          {step.plan.kind === "merge"
            ? t((d) => d.settings.mergeAction)
            : t((d) => d.settings.locateUse)}
        </QuietButton>
      ) : null}
      {step.kind === "refused" && retryable(step.reason) ? (
        <QuietButton onClick={onRetry} disabled={locked}>
          {t((d) => d.scan.tryAgain)}
        </QuietButton>
      ) : null}
      {stoppable ? <QuietButton onClick={onStop}>{t((d) => d.common.cancel)}</QuietButton> : null}
      {stoppable ? null : step.kind === "checking" || step.kind === "confirm" ? (
        <QuietButton onClick={onDismiss}>{t((d) => d.common.cancel)}</QuietButton>
      ) : (
        <QuietButton onClick={onDismiss}>{t((d) => d.common.dismiss)}</QuietButton>
      )}
    </div>
  );
}
