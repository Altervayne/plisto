// -- Framework Imports --
import { useEffect, useRef } from "react";

// -- Component Imports --
import { PlistoLogo } from "../common/PlistoLogo";
import { PrimaryButton } from "../common/PrimaryButton";
import { QuietButton } from "../common/QuietButton";
import { ProgressLine } from "../scan/ProgressLine";

// -- Hook Imports --
import { useMountTransition } from "../../hooks/useMountTransition";

// -- State Imports --
import {
  useInstallUpdate,
  useLaterUpdate,
  useOpenUpdateDetails,
  useUpdateDetails,
  useUpdatePromptOpen,
  useUpdaterState,
} from "../../state/updater/store";
import { updateOf } from "../../state/updater/machine";

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
 * app. It announces the new version under the Plisto mark, with See more... (the details modal), Later
 * (this session) and Update now. Skip lives in the modal. Update now turns the card into a progress bar
 * until the installer takes over and Plisto restarts; a failed install shows its reason with a retry. The
 * card steps aside while the modal is open and returns, focus on See more..., when it closes undecided.
 * Mount once in the main window.
 */
export function UpdatePrompt() {
  const state = useUpdaterState();
  const open = useUpdatePromptOpen();
  const details = useUpdateDetails();
  const install = useInstallUpdate();
  const later = useLaterUpdate();
  const openDetails = useOpenUpdateDetails();
  const t = useT();
  const shown = open && details === null && updateOf(state) != null;
  const card = useMountTransition(shown, EXIT_MS);
  const cardRef = useRef<HTMLDivElement | null>(null);

  // The last state that carried an update, so the card keeps its text through the exit fade.
  const lastState = useRef<UpdaterState>(state);
  if (updateOf(state)) lastState.current = state;
  const view = lastState.current;

  // Focus returns to See more... once the card is back from a modal opened on it. Later and Skip close the
  // card too, which clears the pending return so a later prompt never steals focus.
  const returnFocus = useRef(false);
  useEffect(() => {
    if (details === "prompt") returnFocus.current = true;
    else if (details === null && !shown) returnFocus.current = false;
    else if (shown && returnFocus.current) {
      const more = cardRef.current?.querySelector<HTMLElement>("[data-see-more]");
      if (!more) return;
      more.focus();
      returnFocus.current = false;
    }
  }, [details, shown, card.mounted]);

  if (!card.mounted) return null;
  const update = updateOf(view);
  if (!update) return null;

  return (
    <div ref={cardRef} className={styles.card} data-state={card.state} role="status" aria-live="polite">
      {view.kind === "downloading" || view.kind === "ready" ? (
        <>
          <div className={styles.head}>
            <PlistoLogo height={40} />
            <div className={styles.text}>
              <p className={styles.title}>
                {t((d) => d.updater.downloading, { version: update.version })}
              </p>
            </div>
          </div>
          <ProgressLine value={view.kind === "ready" ? 1 : view.progress} />
          <p className={styles.note}>{t((d) => d.updater.restartNote)}</p>
        </>
      ) : view.kind === "error" ? (
        <>
          <div className={styles.head}>
            <PlistoLogo height={40} />
            <div className={styles.text}>
              <p className={styles.title}>
                {t((d) => d.updater.failedTitle, { version: update.version })}
              </p>
              <p className={styles.error}>{view.message}</p>
            </div>
          </div>
          <div className={styles.actions}>
            <span className={styles.spacer} />
            <QuietButton onClick={later}>{t((d) => d.updater.later)}</QuietButton>
            <PrimaryButton onClick={() => void install()}>{t((d) => d.updater.retry)}</PrimaryButton>
          </div>
        </>
      ) : (
        <>
          <div className={styles.head}>
            <PlistoLogo height={40} />
            <div className={styles.text}>
              <p className={styles.title}>{t((d) => d.updater.available)}</p>
              <span className={styles.pill}>{update.version}</span>
            </div>
          </div>
          <div className={styles.actions}>
            <QuietButton data-see-more="" onClick={() => openDetails("prompt")}>
              {t((d) => d.updater.seeMore)}
            </QuietButton>
            <span className={styles.spacer} />
            <QuietButton onClick={later}>{t((d) => d.updater.later)}</QuietButton>
            <PrimaryButton onClick={() => void install()}>{t((d) => d.updater.updateNow)}</PrimaryButton>
          </div>
        </>
      )}
    </div>
  );
}
