// -- Component Imports --
import { SegmentedControl } from "../common/SegmentedControl";

// -- State Imports --
import { useAppStore } from "../../state/store";
import { useSoundActions, useSoundSettings } from "../../state/sound/useSoundSettings";
import { useLoudnessCoverage } from "../../state/sound/useLoudnessCoverage";

// -- Utils Imports --
import { deriveCoverageState } from "../../state/sound/coverageState";
import { coverageText } from "../../state/sound/coverageText";

// -- i18n Imports --
import { useT } from "../../i18n";

// -- Style Imports --
import styles from "./SettingsView.module.css";
import soundStyles from "./SoundSection.module.css";

/**
 * The loudness levelling setting: the switch with its one-line explanation, then the coverage status,
 * the measuring progress bar (grey while a scan holds the worker back), and a closing note per state.
 */
export function LevellingBlock() {
  const on = useSoundSettings().levelling === "track";
  const { setLevelling } = useSoundActions();
  const scanning = useAppStore((s) => s.scan.status === "scanning");
  const coverage = useLoudnessCoverage(on);
  const t = useT();

  const state = deriveCoverageState(on, scanning, coverage);
  const text = coverageText(state, coverage, t);

  return (
    <>
      <div className={styles.pref}>
        <div className={styles.row}>
          <span className={styles.rowLabel}>{t((d) => d.sound.levelLoudness)}</span>
          <span className={styles.control}>
            <SegmentedControl
              segments={[
                { value: "off", label: t((d) => d.sound.off) },
                { value: "on", label: t((d) => d.sound.on) },
              ]}
              value={on ? "on" : "off"}
              onChange={(value) => setLevelling(value === "on")}
              label={t((d) => d.sound.levelLoudness)}
            />
          </span>
        </div>
        <p className={styles.helper}>{t((d) => d.sound.levellingHelper)}</p>
      </div>

      {text.status && <p className={styles.helper}>{text.status}</p>}
      {text.progress && (
        <div className={soundStyles.progress} data-paused={state === "paused" || undefined}>
          <span className={styles.helper}>{text.progress.text}</span>
          <div className={soundStyles.track}>
            <i style={{ width: `${(text.progress.fraction * 100).toFixed(1)}%` }} />
          </div>
        </div>
      )}
      {text.note && <p className={styles.helper}>{text.note}</p>}
    </>
  );
}
