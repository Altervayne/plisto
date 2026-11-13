// -- Framework Imports --
import { useCallback, useEffect, useId, useRef } from "react";
import { createPortal } from "react-dom";

// -- Library Imports --
import { X } from "lucide-react";

// -- Component Imports --
import { IconButton } from "../common/IconButton";
import { PlistoLogo } from "../common/PlistoLogo";
import { ReleaseNotes } from "./ReleaseNotes";
import { UpdateDetailsFooter } from "./UpdateDetailsFooter";

// -- Hook Imports --
import { useMountTransition } from "../../hooks/useMountTransition";

// -- State Imports --
import {
  useCloseUpdateDetails,
  useIsSkippedUpdate,
  useUpdateDetails,
  useUpdaterState,
} from "../../state/updater/store";
import { updateOf } from "../../state/updater/machine";

// -- Utils Imports --
import { formatReleaseDate } from "./releaseDate";

// -- i18n Imports --
import { useLocale, useT } from "../../i18n";

// -- Type Imports --
import type { UpdaterState } from "../../state/updater/machine";

// -- Style Imports --
import styles from "./UpdateDetails.module.css";

/** The sheet's exit before it unmounts, matching --dur-fast on the exit keyframe. */
const EXIT_MS = 120;

const FOCUSABLE = 'button:not(:disabled), [tabindex="0"]';

/**
 * The update details modal, on the confirm dialog's scrim and lifted card: the new version over the one
 * the user runs, the release notes (as published, so English whatever the app language) and the decisions.
 * The x, Escape and a click on the scrim only close it. Update now keeps it open on the progress line.
 * Focus lands on the primary action, stays inside while open, and returns to the opener on a plain close;
 * Later and Skip hand focus back to the app. Mount once in the main window.
 */
export function UpdateDetails() {
  const state = useUpdaterState();
  const origin = useUpdateDetails();
  const close = useCloseUpdateDetails();
  const locale = useLocale();
  const t = useT();
  const titleId = useId();
  const open = origin !== null && updateOf(state) != null;
  const sheet = useMountTransition(open, EXIT_MS);
  const dialogRef = useRef<HTMLDivElement | null>(null);
  const opener = useRef<HTMLElement | null>(null);

  // The last state and origin that carried an update, so the sheet keeps its content through the exit fade.
  const lastState = useRef<UpdaterState>(state);
  if (updateOf(state)) lastState.current = state;
  const view = lastState.current;
  const lastOrigin = useRef(origin);
  if (origin) lastOrigin.current = origin;
  const skipped = useIsSkippedUpdate(updateOf(view)?.version ?? "");

  // A plain close: nothing is decided, and focus goes back to whatever opened the modal if it still exists.
  // The prompt's See more... is gone while the modal is up and takes focus itself when the card returns.
  const dismiss = useCallback(() => {
    close();
    if (opener.current?.isConnected) opener.current.focus();
  }, [close]);

  useEffect(() => {
    if (open) opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  }, [open]);

  // Focus the primary action, or the sheet itself when a state has none (the download in flight).
  const kind = view.kind;
  useEffect(() => {
    if (!open || !sheet.mounted) return;
    const dialog = dialogRef.current;
    if (!dialog) return;
    (dialog.querySelector<HTMLElement>("[data-autofocus]") ?? dialog).focus();
  }, [open, sheet.mounted, kind]);

  useEffect(() => {
    if (!open) return;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        dismiss();
        return;
      }
      if (event.key !== "Tab") return;
      const dialog = dialogRef.current;
      if (!dialog) return;
      const nodes = Array.from(dialog.querySelectorAll<HTMLElement>(FOCUSABLE));
      const active = document.activeElement;
      const first = nodes[0];
      const last = nodes[nodes.length - 1];
      if (!first || !dialog.contains(active)) {
        event.preventDefault();
        (first ?? dialog).focus();
      } else if (event.shiftKey && (active === first || active === dialog)) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && active === last) {
        event.preventDefault();
        first.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, dismiss]);

  const update = updateOf(view);
  if (!sheet.mounted || !update) return null;
  const released = formatReleaseDate(update.date, locale);

  return createPortal(
    <div className={styles.overlay} data-state={sheet.state}>
      <div className={styles.backdrop} onClick={dismiss} aria-hidden="true" />
      <div
        ref={dialogRef}
        className={styles.sheet}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
      >
        <div className={styles.header}>
          <PlistoLogo height={44} />
          <div className={styles.headText}>
            <h2 id={titleId} className={styles.title}>
              {t((d) => d.updater.currentVersion, { version: update.version })}
            </h2>
            <div className={`${styles.meta} tabular`}>
              <span>{t((d) => d.updater.youHave, { version: update.currentVersion })}</span>
              {released ? (
                <>
                  <i className={styles.dot} aria-hidden="true" />
                  <span>{t((d) => d.updater.released, { date: released })}</span>
                </>
              ) : null}
            </div>
            {locale !== "en" ? (
              <p className={styles.languageNote}>{t((d) => d.updater.notesLanguageNote)}</p>
            ) : null}
          </div>
          <IconButton aria-label={t((d) => d.updater.close)} onClick={dismiss}>
            <X size={18} strokeWidth={1.8} />
          </IconButton>
        </div>
        <ReleaseNotes notes={update.notes} />
        <div className={styles.footer}>
          <UpdateDetailsFooter
            view={view}
            origin={lastOrigin.current ?? "prompt"}
            skipped={skipped}
            onClose={dismiss}
          />
        </div>
      </div>
    </div>,
    document.body,
  );
}
