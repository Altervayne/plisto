// -- Framework Imports --
import { useState } from "react";

// -- Component Imports --
import { PrimaryButton } from "../common/PrimaryButton";
import { QuietButton } from "../common/QuietButton";

// -- Type Imports --
import type { FrameCrashReason } from "../../state/plugins/frameHealth";

// -- i18n Imports --
import { useT } from "../../i18n";

// -- Style Imports --
import styles from "./CrashCard.module.css";

/**
 * What a plugin page shows after its frame stopped. Restart mounts a fresh frame, Disable turns the
 * plugin off, and Show details names why the frame was dropped. Static: no motion of any kind.
 */
export function CrashCard({
  name,
  reason,
  onRestart,
  onDisable,
}: {
  name: string;
  reason: FrameCrashReason | undefined;
  onRestart: () => void;
  onDisable: () => void;
}) {
  const t = useT();
  const [open, setOpen] = useState(false);

  return (
    <div className={styles.card}>
      <span className={styles.dot} aria-hidden="true" />
      <h2 className={styles.title}>{t((d) => d.plugins.frame.crashTitle, { name })}</h2>
      <p className={styles.line}>{t((d) => d.plugins.frame.crashLine, { name })}</p>
      <div className={styles.actions}>
        <PrimaryButton onClick={onRestart}>{t((d) => d.plugins.frame.restart)}</PrimaryButton>
        <QuietButton onClick={onDisable}>{t((d) => d.plugins.frame.disable)}</QuietButton>
        <QuietButton aria-expanded={open} onClick={() => setOpen((v) => !v)}>
          {t((d) => (open ? d.plugins.frame.hideDetails : d.plugins.frame.showDetails))}
        </QuietButton>
      </div>
      {open ? (
        <p className={styles.detail}>
          {t((d) =>
            reason === "navigated"
              ? d.plugins.frame.reasonNavigated
              : reason === "init"
                ? d.plugins.frame.reasonInit
                : d.plugins.frame.reasonSilent,
          )}
        </p>
      ) : null}
    </div>
  );
}
