// -- Framework Imports --
import { useEffect, useState } from "react";

// -- Component Imports --
import { QuietButton } from "../common/QuietButton";
import { SegmentedControl } from "../common/SegmentedControl";
import { SettingRow } from "./SettingRow";
import { sectionAttr } from "./settingsSections";

// -- State Imports --
import { useSetUpdaterAutoCheck, useUpdaterAutoCheck } from "../../state/preferences/store";
import {
  useCheckForUpdate,
  useIsSkippedUpdate,
  useOpenUpdateDetails,
  useUpdaterState,
} from "../../state/updater/store";
import { updateOf } from "../../state/updater/machine";

// -- Utils Imports --
import { appVersion } from "../../lib/updater";

// -- i18n Imports --
import { useT } from "../../i18n";

// -- Type Imports --
import type { Segment } from "../common/SegmentedControl";

// -- Style Imports --
import styles from "./SettingsView.module.css";
import updateStyles from "./UpdatesSection.module.css";

/**
 * The Settings Updates section: the running version beside Check for updates, the automatic-check
 * switch, then one line for the last result. A found update keeps a See more... link on that line, which
 * opens the details modal; a failed check or install states its reason in the warn tone.
 */
export function UpdatesSection() {
  const state = useUpdaterState();
  const check = useCheckForUpdate();
  const openDetails = useOpenUpdateDetails();
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

  const autoCheck = useUpdaterAutoCheck();
  const setAutoCheck = useSetUpdaterAutoCheck();
  const skipped = useIsSkippedUpdate(updateOf(state)?.version ?? "");
  const autoSegments: Segment<"on" | "off">[] = [
    { value: "on", label: t((d) => d.settings.keepOn) },
    { value: "off", label: t((d) => d.settings.keepOff) },
  ];

  const busy = state.kind === "checking" || state.kind === "downloading" || state.kind === "ready";

  return (
    <section className={styles.section} {...sectionAttr("updates")}>
      <h2 className={styles.label}>{t((d) => d.updater.section)}</h2>
      <div className={styles.pref}>
        <SettingRow id="checkForUpdates">
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
        </SettingRow>
        {state.kind === "checking" ? (
          <p className={styles.helper}>{t((d) => d.updater.checking)}</p>
        ) : state.kind === "upToDate" ? (
          <p className={styles.helper}>{t((d) => d.updater.upToDate)}</p>
        ) : state.kind === "available" ||
          state.kind === "downloading" ||
          state.kind === "ready" ? (
          <p className={`${styles.helper} tabular`}>
            {skipped
              ? t((d) => d.updater.skippedLine, { version: state.update.version })
              : t((d) => d.updater.availableLine, { version: state.update.version })}{" "}
            <button type="button" className={updateStyles.show} onClick={() => openDetails("settings")}>
              {t((d) => d.updater.seeMore)}
            </button>
          </p>
        ) : state.kind === "error" ? (
          <p className={updateStyles.failed}>
            {state.update
              ? t((d) => d.updater.installFailed, { reason: state.message })
              : t((d) => d.updater.checkFailed, { reason: state.message })}
            {state.update ? (
              <>
                {" "}
                <button
                  type="button"
                  className={updateStyles.show}
                  onClick={() => openDetails("settings")}
                >
                  {t((d) => d.updater.seeMore)}
                </button>
              </>
            ) : null}
          </p>
        ) : null}
        <SettingRow id="autoCheck">
          <div className={styles.row}>
            <span className={styles.rowLabel}>{t((d) => d.updater.autoCheck)}</span>
            <span className={styles.control}>
              <SegmentedControl
                segments={autoSegments}
                value={autoCheck ? "on" : "off"}
                onChange={(value) => setAutoCheck(value === "on")}
                label={t((d) => d.updater.autoCheck)}
              />
            </span>
          </div>
        </SettingRow>
        <p className={styles.helper}>{t((d) => d.updater.autoCheckHint)}</p>
      </div>
    </section>
  );
}
