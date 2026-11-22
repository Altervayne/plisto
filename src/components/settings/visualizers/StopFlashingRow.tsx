// -- Component Imports --
import { Switch } from "../../common/Switch/Switch";
import { SettingRow } from "../SettingRow";

// -- State Imports --
import {
  usePlayerVisualizerStopFlashing,
  usePreferencesLoaded,
  useSetPlayerVisualizerStopFlashing,
} from "../../../state/preferences/store";

// -- i18n Imports --
import { useT } from "../../../i18n";

// -- Style Imports --
import settingsStyles from "../SettingsView.module.css";

/** The switch that stops plugin visualizers whose flash meter trips. Off by default, and held until read. */
export function StopFlashingRow() {
  const t = useT();
  const on = usePlayerVisualizerStopFlashing();
  const setOn = useSetPlayerVisualizerStopFlashing();
  const loaded = usePreferencesLoaded();
  const label = t((d) => d.settings.visualizersStopFlashing);

  return (
    <SettingRow id="visualizerStopFlashing" className={settingsStyles.pref}>
      <div className={settingsStyles.row}>
        <span className={settingsStyles.rowLabel}>{label}</span>
        <Switch checked={on} onChange={setOn} label={label} disabled={!loaded} />
      </div>
      <p className={settingsStyles.helper}>{t((d) => d.settings.visualizersStopFlashingHint)}</p>
    </SettingRow>
  );
}
