// -- Component Imports --
import { QuietButton } from "../../common/QuietButton";
import { RestartFailure } from "../../plugins/RestartFailure";
import { SettingRow } from "../SettingRow";

// -- State Imports --
import { usePluginRuntime } from "../../../state/plugins/store";
import { useRestart } from "../../../state/plugins/useRestart";

// -- i18n Imports --
import { useT } from "../../../i18n";

// -- Type Imports --
import type { PluginErrorKey } from "../../../state/plugins/errors";

// -- Style Imports --
import settingsStyles from "../SettingsView.module.css";

/** The row: restart without plugins while they run, restart normally while the session has them off. */
export function SafeModeEntryView({
  safe,
  onRestart,
  error = null,
  onDismiss = () => {},
}: {
  safe: boolean;
  onRestart: () => void;
  error?: PluginErrorKey | null;
  onDismiss?: () => void;
}) {
  const t = useT();
  return (
    <SettingRow id="safeMode" className={settingsStyles.pref}>
      <div className={settingsStyles.row}>
        <span className={settingsStyles.rowLabel}>{t((d) => d.plugins.safeEntry.label)}</span>
        <span className={`${settingsStyles.control} ${settingsStyles.controlQuiet}`}>
          <QuietButton onClick={onRestart}>
            {safe ? t((d) => d.plugins.safeEntry.restartNormal) : t((d) => d.plugins.safeEntry.restartSafe)}
          </QuietButton>
        </span>
      </div>
      <p className={settingsStyles.helper}>
        {safe ? t((d) => d.plugins.safeEntry.helperSafe) : t((d) => d.plugins.safeEntry.helperRunning)}
      </p>
      {error ? <RestartFailure error={error} onDismiss={onDismiss} /> : null}
    </SettingRow>
  );
}

/** The Settings entry for safe mode. */
export function SafeModeEntry() {
  const safe = usePluginRuntime() === "safe";
  const { error, restart, dismiss } = useRestart();
  return <SafeModeEntryView safe={safe} onRestart={() => restart(!safe)} error={error} onDismiss={dismiss} />;
}
