// -- Framework Imports --
import { useEffect, useId, useRef } from "react";

// -- i18n Imports --
import { useT } from "../../../i18n";

// -- Style Imports --
import styles from "./NotRespondingOverlay.module.css";

/**
 * The veil and card over a frame that has stopped answering. Wait gives it more time, Disable turns the
 * plugin off. It carries no motion: it appears and leaves as a plain mount. Focus moves to Wait only
 * when it was inside the frame, where keys typed into a hung page are lost; otherwise it stays put.
 */
export function NotRespondingOverlay({
  name,
  focusInFrame,
  onWait,
  onDisable,
}: {
  name: string;
  /** Whether keyboard focus sits in the frame behind the veil, read once when the overlay appears. */
  focusInFrame: () => boolean;
  onWait: () => void;
  onDisable: () => void;
}) {
  const t = useT();
  const titleId = useId();
  const lineId = useId();
  const waitRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (focusInFrame()) waitRef.current?.focus();
    // Read once, on appearing: later focus moves are the user's.
  }, []);

  return (
    <div className={styles.veil}>
      <div
        className={styles.card}
        role="alertdialog"
        aria-modal="false"
        aria-labelledby={titleId}
        aria-describedby={lineId}
      >
        <h3 id={titleId} className={styles.title}>
          {t((d) => d.plugins.frame.notRespondingTitle, { name })}
        </h3>
        <p id={lineId} className={styles.line}>
          {t((d) => d.plugins.frame.notRespondingLine)}
        </p>
        <div className={styles.actions}>
          <button ref={waitRef} type="button" className={`${styles.btn} ${styles.cancel}`} onClick={onWait}>
            {t((d) => d.plugins.frame.wait)}
          </button>
          <button type="button" className={styles.btn} onClick={onDisable}>
            {t((d) => d.plugins.frame.disable)}
          </button>
        </div>
      </div>
    </div>
  );
}
