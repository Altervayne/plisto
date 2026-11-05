// -- Icon Imports --
import { Minus, Plus, RotateCcw } from "lucide-react";

// -- Component Imports --
import { IconButton } from "../common/IconButton";
import { QuietButton } from "../common/QuietButton";
import { SegmentedControl } from "../common/SegmentedControl";
import { EqCurve } from "../sound/EqCurve";
import { PresetRow } from "../sound/PresetRow";

// -- State Imports --
import { useCurrentTrackId } from "../../state/player/store";
import { useSoundActions, useSoundSettings } from "../../state/sound/useSoundSettings";

// -- Utils Imports --
import { canReset } from "../../state/sound/presets";
import { PREAMP_MAX_DB, PREAMP_MIN_DB } from "../../state/sound/settings";
import { formatDb } from "../sound/formatDb";
import { SOUND_SECTION_ID } from "../sound/soundSectionId";

// -- i18n Imports --
import { useT } from "../../i18n";

// -- Style Imports --
import styles from "./SettingsView.module.css";
import soundStyles from "./SoundSection.module.css";

const PREAMP_STEP_DB = 0.5;

/**
 * The Settings Sound section: the EQ switch, the preset row, the full-width draggable curve, and the
 * preamp as one quiet value with minus and plus. When a band is boosted, a helper line states the
 * headroom the engine takes off automatically.
 */
export function SoundSection() {
  const settings = useSoundSettings();
  const actions = useSoundActions();
  const nothingPlaying = useCurrentTrackId() == null;
  const t = useT();

  const boost = settings.eq.on ? Math.max(0, ...settings.eq.gains) : 0;
  const nudge = (delta: number) => actions.setPreamp(settings.preampDb + delta);

  return (
    <section className={styles.section} id={SOUND_SECTION_ID}>
      <h2 className={styles.label}>{t((d) => d.settings.sectionSound)}</h2>

      <div className={styles.pref}>
        <div className={styles.row}>
          <span className={styles.rowLabel}>{t((d) => d.sound.equalizer)}</span>
          <span className={styles.control}>
            <SegmentedControl
              segments={[
                { value: "off", label: t((d) => d.sound.off) },
                { value: "on", label: t((d) => d.sound.on) },
              ]}
              value={settings.eq.on ? "on" : "off"}
              onChange={(value) => actions.setOn(value === "on")}
              label={t((d) => d.sound.equalizer)}
            />
          </span>
        </div>
      </div>

      <div className={styles.pref}>
        <div className={styles.row}>
          <span className={styles.rowLabel}>{t((d) => d.sound.preset)}</span>
        </div>
        <PresetRow />
      </div>

      <EqCurve
        gains={settings.eq.gains}
        on={settings.eq.on}
        width={624}
        plotHeight={132}
        onGain={actions.setGain}
        idleNote={nothingPlaying ? t((d) => d.sound.idle) : null}
      />

      <div className={styles.pref}>
        <div className={styles.row}>
          <span className={styles.rowLabel}>{t((d) => d.sound.preamp)}</span>
          <span className={soundStyles.preamp}>
            <span className={soundStyles.stepper}>
              <IconButton
                aria-label={t((d) => d.sound.lowerPreamp)}
                disabled={settings.preampDb <= PREAMP_MIN_DB}
                onClick={() => nudge(-PREAMP_STEP_DB)}
              >
                <Minus size={15} strokeWidth={1.8} />
              </IconButton>
              <span className={soundStyles.value}>{formatDb(settings.preampDb)}</span>
              <IconButton
                aria-label={t((d) => d.sound.raisePreamp)}
                disabled={settings.preampDb >= PREAMP_MAX_DB}
                onClick={() => nudge(PREAMP_STEP_DB)}
              >
                <Plus size={15} strokeWidth={1.8} />
              </IconButton>
            </span>
            <QuietButton onClick={actions.reset} disabled={!canReset(settings)}>
              <RotateCcw size={15} strokeWidth={1.8} />
              {t((d) => d.sound.reset)}
            </QuietButton>
          </span>
        </div>
        <p className={styles.helper}>
          {boost > 0
            ? t((d) => d.sound.headroomTaken, {
                change: formatDb(settings.preampDb - boost),
                boost: formatDb(boost),
              })
            : t((d) => d.sound.headroomNone)}
        </p>
      </div>

      {/* Loudness levelling joins this section below the preamp. */}
    </section>
  );
}
