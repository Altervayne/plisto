// -- Icon Imports --
import { ArrowRight, RotateCcw } from "lucide-react";

// -- Component Imports --
import { QuietButton } from "../common/QuietButton";
import { SegmentedControl } from "../common/SegmentedControl";
import { EqCurve } from "./EqCurve";
import { PresetRow } from "./PresetRow";

// -- State Imports --
import { useCurrentTrackId } from "../../state/player/store";
import { useOpenSettings } from "../../state/shell/store";
import { useSoundActions, useSoundSettings } from "../../state/sound/useSoundSettings";

// -- Utils Imports --
import { canReset } from "../../state/sound/presets";
import { formatDb } from "./formatDb";
import { SOUND_SECTION_ID } from "./soundSectionId";

// -- i18n Imports --
import { useT } from "../../i18n";

// -- Style Imports --
import styles from "./SoundPopover.module.css";

/** Settles after the Settings view mounts, so the Sound section exists to scroll to. */
const SCROLL_DELAY_MS = 80;

/**
 * The Sound card: the EQ switch, the preset row, a compact draggable curve, the preamp readout with Reset,
 * and a link to the full controls in Settings. Sound is a setting, so it stays editable with nothing
 * playing; the curve then says it applies once something plays.
 */
export function SoundPopover({ onClose }: { onClose: () => void }) {
  const settings = useSoundSettings();
  const actions = useSoundActions();
  const nothingPlaying = useCurrentTrackId() == null;
  const openSettings = useOpenSettings();
  const t = useT();

  const goToSettings = () => {
    onClose();
    openSettings();
    window.setTimeout(() => {
      document.getElementById(SOUND_SECTION_ID)?.scrollIntoView({ block: "start" });
    }, SCROLL_DELAY_MS);
  };

  return (
    <div className={styles.pop} role="dialog" aria-label={t((d) => d.sound.title)}>
      <div className={styles.head}>
        <span className={styles.title}>{t((d) => d.sound.title)}</span>
        <span className={styles.onoff}>
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

      <PresetRow compact />

      <div className={styles.curve}>
        <EqCurve
          gains={settings.eq.gains}
          on={settings.eq.on}
          width={288}
          plotHeight={104}
          onGain={actions.setGain}
          idleNote={nothingPlaying ? t((d) => d.sound.idle) : null}
        />
      </div>

      <div className={styles.foot}>
        <span className={styles.value}>
          {t((d) => d.sound.preamp)} <b>{formatDb(settings.preampDb)}</b>
        </span>
        <QuietButton onClick={actions.reset} disabled={!canReset(settings)}>
          <RotateCcw size={15} strokeWidth={1.8} />
          {t((d) => d.sound.reset)}
        </QuietButton>
      </div>

      <div className={styles.sep} role="separator" />
      <button type="button" className={styles.link} onClick={goToSettings}>
        {t((d) => d.sound.moreInSettings)}
        <ArrowRight size={14} strokeWidth={1.8} />
      </button>
    </div>
  );
}
