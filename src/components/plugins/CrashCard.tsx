// -- Framework Imports --
import { useState } from "react";

// -- Component Imports --
import { PrimaryButton } from "../common/PrimaryButton";
import { QuietButton } from "../common/QuietButton";

// -- Utils Imports --
import { crashLine } from "./statusText";

// -- Type Imports --
import type { CrashDetail } from "../../state/plugins/statusModel";

// -- i18n Imports --
import { useT } from "../../i18n";

// -- Style Imports --
import styles from "./CrashCard.module.css";

/**
 * What a plugin page shows after the plugin stopped. `stopped` waits for the user: Restart brings it
 * back, Disable turns it off. `restarting` says Plisto is already restarting it, so only Disable is
 * left. Show details prints one line about the crash. Static: no motion of any kind.
 */
export function CrashCard({
  name,
  variant,
  detail,
  onRestart,
  onDisable,
}: {
  name: string;
  variant: "stopped" | "restarting";
  detail: CrashDetail | null;
  onRestart: () => void;
  onDisable: () => void;
}) {
  const t = useT();
  const [open, setOpen] = useState(false);

  return (
    <div className={styles.card}>
      <span className={styles.dot} aria-hidden="true" />
      <h2 className={styles.title}>{t((d) => d.plugins.frame.crashTitle, { name })}</h2>
      <p className={styles.line}>
        {variant === "restarting"
          ? t((d) => d.plugins.frame.restartingLine)
          : t((d) => d.plugins.frame.crashLine, { name })}
      </p>
      <div className={styles.actions}>
        {variant === "stopped" ? (
          <PrimaryButton onClick={onRestart}>{t((d) => d.plugins.frame.restart)}</PrimaryButton>
        ) : null}
        <QuietButton onClick={onDisable}>{t((d) => d.plugins.frame.disable)}</QuietButton>
        {detail ? (
          <QuietButton aria-expanded={open} onClick={() => setOpen((v) => !v)}>
            {t((d) => (open ? d.plugins.frame.hideDetails : d.plugins.frame.showDetails))}
          </QuietButton>
        ) : null}
      </div>
      {open && detail ? <p className={styles.detail}>{crashLine(detail, name, t)}</p> : null}
    </div>
  );
}
