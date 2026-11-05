// -- Component Imports --
import { SegmentedControl } from "../common/SegmentedControl";

// -- State Imports --
import { useSoundActions, useSoundSettings } from "../../state/sound/useSoundSettings";

// -- Utils Imports --
import { detectPreset, PRESET_KEYS } from "../../state/sound/presets";

// -- Type Imports --
import type { Segment } from "../common/SegmentedControl";
import type { PresetChoice } from "../../state/sound/presets";

// -- i18n Imports --
import { useT } from "../../i18n";

// -- Style Imports --
import styles from "./PresetRow.module.css";

/**
 * The preset choice as one segmented row. The selected chip follows the gains, so a hand edit that matches
 * no preset lights a sixth chip, Custom, that exists only while it applies and does nothing when clicked.
 * `compact` squeezes the row to fill a narrow popover.
 */
export function PresetRow({ compact = false }: { compact?: boolean }) {
  const settings = useSoundSettings();
  const actions = useSoundActions();
  const t = useT();
  const current = detectPreset(settings.eq.gains);

  const labels: Record<PresetChoice, string> = {
    flat: t((d) => d.sound.presetFlat),
    bass: t((d) => d.sound.presetBass),
    treble: t((d) => d.sound.presetTreble),
    vocal: t((d) => d.sound.presetVocal),
    loudness: t((d) => d.sound.presetLoudness),
    custom: t((d) => d.sound.presetCustom),
  };
  const choices: PresetChoice[] = current === "custom" ? [...PRESET_KEYS, "custom"] : [...PRESET_KEYS];
  const segments: Segment<PresetChoice>[] = choices.map((value) => ({ value, label: labels[value] }));

  return (
    <div className={compact ? styles.compact : undefined}>
      <SegmentedControl
        segments={segments}
        value={current}
        onChange={(value) => {
          if (value !== "custom") actions.applyPreset(value);
        }}
        label={t((d) => d.sound.preset)}
      />
    </div>
  );
}
