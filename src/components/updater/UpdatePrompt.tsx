// -- Framework Imports --
import { useRef } from "react";

// -- Component Imports --
import { PrimaryButton } from "../common/PrimaryButton";
import { QuietButton } from "../common/QuietButton";
import { ProgressLine } from "../scan/ProgressLine";

// -- Hook Imports --
import { useMountTransition } from "../../hooks/useMountTransition";

// -- State Imports --
import {
  useInstallUpdate,
  useIsSkippedUpdate,
  useLaterUpdate,
  useSkipUpdate,
  useUpdatePromptOpen,
  useUpdaterState,
} from "../../state/updater/store";
import { updateOf } from "../../state/updater/machine";

// -- Local Imports --
import { notesExcerpt } from "./notesExcerpt";

// -- i18n Imports --
import { useT } from "../../i18n";

// -- Type Imports --
import type { UpdaterState } from "../../state/updater/machine";

// -- Style Imports --
import styles from "./UpdatePrompt.module.css";

/** The card's exit before it unmounts, matching --dur-fast on the exit keyframe. */
const EXIT_MS = 120;

/**
 * The update prompt: a card in the window's lower corner, on the toast material, that never blocks the
 * app. It names the new version over a short excerpt of its notes, with Later (this session), Skip this
 * version (stored) and Update now. A skipped version opened by hand notes it and drops Skip. Update now
 * turns the card into a progress bar until the installer takes over and Plisto restarts. A failed install
 * shows its reason in the card with a retry. Mount once in the main window.
 */
export function UpdatePrompt() {
  const state = useUpdaterState();
  const open = useUpdatePromptOpen();
  const install = useInstallUpdate();
  const later = useLaterUpdate();
  const skip = useSkipUpdate();
  const t = useT();
  const shown = open && updateOf(state) != null;
  const card = useMountTransition(shown, EXIT_MS);

  // The last state that carried an update, so the card keeps its text through the exit fade.
  const lastState = useRef<UpdaterState>(state);
  if (updateOf(state)) lastState.current = state;
  const view = lastState.current;
  const skipped = useIsSkippedUpdate(updateOf(view)?.version ?? "");

  if (!card.mounted) return null;
  const update = updateOf(view);
  if (!update) return null;

  return (
    <div className={styles.card} data-state={card.state} role="status" aria-live="polite">
      {view.kind === "downloading" || view.kind === "ready" ? (
        <>
          <p className={styles.title}>
            {t((d) => d.updater.downloading, { version: update.version })}
          </p>
          <ProgressLine value={view.kind === "ready" ? 1 : view.progress} />
          <p className={styles.note}>{t((d) => d.updater.restartNote)}</p>
        </>
      ) : view.kind === "error" ? (
        <>
          <p className={styles.title}>{t((d) => d.updater.failedTitle, { version: update.version })}</p>
          <p className={styles.error}>{view.message}</p>
          <div className={styles.actions}>
            <QuietButton onClick={later}>{t((d) => d.updater.later)}</QuietButton>
            <PrimaryButton onClick={() => void install()}>{t((d) => d.updater.retry)}</PrimaryButton>
          </div>
        </>
      ) : (
        <>
          <p className={styles.title}>{t((d) => d.updater.available, { version: update.version })}</p>
          {update.notes ? <p className={styles.notes}>{notesExcerpt(update.notes)}</p> : null}
          {skipped ? <p className={styles.note}>{t((d) => d.updater.skippedNote)}</p> : null}
          <div className={styles.actions}>
            <QuietButton onClick={later}>{t((d) => d.updater.later)}</QuietButton>
            {skipped ? null : (
              <QuietButton onClick={skip}>{t((d) => d.updater.skip)}</QuietButton>
            )}
            <PrimaryButton onClick={() => void install()}>{t((d) => d.updater.updateNow)}</PrimaryButton>
          </div>
        </>
      )}
    </div>
  );
}
