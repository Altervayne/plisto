// -- Component Imports --
import { PrimaryButton } from "../common/PrimaryButton";
import { QuietButton } from "../common/QuietButton";
import { ProgressLine } from "../scan/ProgressLine";

// -- State Imports --
import { useInstallUpdate, useLaterUpdate, useSkipUpdate } from "../../state/updater/store";
import { updateOf } from "../../state/updater/machine";

// -- i18n Imports --
import { useT } from "../../i18n";

// -- Type Imports --
import type { UpdaterState } from "../../state/updater/machine";
import type { DetailsOrigin } from "../../state/updater/store";

// -- Style Imports --
import styles from "./UpdateDetails.module.css";

/**
 * The modal's footer for one state. Available: Skip this version (or the note that it is skipped) at the
 * left, the dismissal and Update now at the right. The dismissal is Later when the modal came from the
 * prompt and Close when it came from Settings. Downloading shows only progress and the restart note; a
 * failed install shows its reason with the dismissal and Try again.
 */
export function UpdateDetailsFooter({
  view,
  origin,
  skipped,
  onClose,
}: {
  view: UpdaterState;
  origin: DetailsOrigin;
  skipped: boolean;
  onClose: () => void;
}) {
  const t = useT();
  const install = useInstallUpdate();
  const later = useLaterUpdate();
  const skip = useSkipUpdate();
  const update = updateOf(view);
  if (!update) return null;

  const dismiss =
    origin === "prompt" ? (
      <QuietButton onClick={later}>{t((d) => d.updater.later)}</QuietButton>
    ) : (
      <QuietButton onClick={onClose}>{t((d) => d.updater.close)}</QuietButton>
    );

  if (view.kind === "downloading" || view.kind === "ready") {
    return (
      <div className={styles.progress}>
        <p className={styles.footTitle}>{t((d) => d.updater.downloading, { version: update.version })}</p>
        <ProgressLine value={view.kind === "ready" ? 1 : view.progress} />
        <p className={styles.footNote}>{t((d) => d.updater.restartNote)}</p>
      </div>
    );
  }

  if (view.kind === "error") {
    return (
      <>
        <div className={styles.failure}>
          <p className={styles.footTitle}>{t((d) => d.updater.failedTitle, { version: update.version })}</p>
          <p className={styles.error}>{view.message}</p>
        </div>
        <div className={styles.actions}>
          <span className={styles.spacer} />
          {dismiss}
          <PrimaryButton data-autofocus="" onClick={() => void install()}>
            {t((d) => d.updater.retry)}
          </PrimaryButton>
        </div>
      </>
    );
  }

  return (
    <div className={styles.actions}>
      {skipped ? (
        <span className={styles.skippedNote}>{t((d) => d.updater.skippedNote)}</span>
      ) : (
        <QuietButton onClick={skip}>{t((d) => d.updater.skip)}</QuietButton>
      )}
      <span className={styles.spacer} />
      {dismiss}
      <PrimaryButton data-autofocus="" onClick={() => void install()}>
        {t((d) => d.updater.updateNow)}
      </PrimaryButton>
    </div>
  );
}
