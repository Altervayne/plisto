// -- Framework Imports --
import { useEffect, useState } from "react";

// -- Component Imports --
import { QuietButton } from "../common/QuietButton";

// -- State Imports --
import {
  useCheckForUpdate,
  useOpenUpdatePrompt,
  useUpdaterState,
} from "../../state/updater/store";

// -- Utils Imports --
import { appVersion } from "../../lib/updater";

// -- i18n Imports --
import { useT } from "../../i18n";

// -- Style Imports --
import styles from "./SettingsView.module.css";
import updateStyles from "./UpdatesSection.module.css";

/**
 * The Settings Updates section: the running version beside Check for updates, then one line for the
 * last result. A found update opens the prompt, and the line keeps a Show link back to it; a failed
 * check or install states its reason in the warn tone.
 */
export function UpdatesSection() {
  const state = useUpdaterState();
  const check = useCheckForUpdate();
  const openPrompt = useOpenUpdatePrompt();
  const t = useT();
  const [version, setVersion] = useState<string | null>(null);

  useEffect(() => {
    let alive = true;
    void appVersion().then((v) => {
      if (alive) setVersion(v);
    });
    return () => {
      alive = false;
    };
  }, []);

  const busy = state.kind === "checking" || state.kind === "downloading" || state.kind === "ready";

  return (
    <section className={styles.section}>
      <h2 className={styles.label}>{t((d) => d.updater.section)}</h2>
      <div className={styles.pref}>
        <div className={styles.row}>
          <span className={`${styles.rowLabel} tabular`}>
            {version ? t((d) => d.updater.currentVersion, { version }) : "Plisto"}
          </span>
          <span className={`${styles.control} ${styles.controlQuiet}`}>
            <QuietButton onClick={() => void check("manual")} disabled={busy}>
              {t((d) => d.updater.check)}
            </QuietButton>
          </span>
        </div>
        {state.kind === "checking" ? (
          <p className={styles.helper}>{t((d) => d.updater.checking)}</p>
        ) : state.kind === "upToDate" ? (
          <p className={styles.helper}>{t((d) => d.updater.upToDate)}</p>
        ) : state.kind === "available" ||
          state.kind === "downloading" ||
          state.kind === "ready" ? (
          <p className={`${styles.helper} tabular`}>
            {t((d) => d.updater.availableLine, { version: state.update.version })}{" "}
            <button type="button" className={updateStyles.show} onClick={openPrompt}>
              {t((d) => d.updater.show)}
            </button>
          </p>
        ) : state.kind === "error" ? (
          <p className={updateStyles.failed}>
            {state.update
              ? t((d) => d.updater.installFailed, { reason: state.message })
              : t((d) => d.updater.checkFailed, { reason: state.message })}
          </p>
        ) : null}
      </div>
    </section>
  );
}
