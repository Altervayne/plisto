// -- Framework Imports --
import type { Ref } from "react";

// -- Component Imports --
import { Switch } from "../../common/Switch/Switch";
import { SettingRow } from "../SettingRow";
import { PluginLogPanel } from "./PluginLogPanel";

// -- State Imports --
import { useProbe } from "../../../state/plugins/sandboxStore";

// -- i18n Imports --
import { useT } from "../../../i18n";

// -- Type Imports --
import type { PluginRow } from "../../../types";

// -- Style Imports --
import settingsStyles from "../SettingsView.module.css";
import styles from "./DevModeEntry.module.css";

/**
 * The developer-mode row at the foot of the Plugins section: one quiet switch and its helper. While it
 * is on, it adds the sandbox check line and the log panel, which opens on `logId` (the first plugin when
 * that one is gone).
 */
export function DevModeEntry({
  on,
  disabled,
  onToggle,
  rows,
  logId,
  onSelectLog,
  panelRef,
}: {
  on: boolean;
  disabled: boolean;
  onToggle: (on: boolean) => void;
  rows: PluginRow[];
  logId: string | null;
  onSelectLog: (id: string) => void;
  panelRef: Ref<HTMLDivElement>;
}) {
  const t = useT();
  const passed = useProbe() === "passed";
  const active = rows.find((r) => r.id === logId) ?? rows[0];

  return (
    <SettingRow id="developerMode" className={settingsStyles.pref}>
      <div className={settingsStyles.row}>
        <span className={settingsStyles.rowLabel}>{t((d) => d.plugins.devMode.label)}</span>
        <Switch
          checked={on}
          onChange={onToggle}
          label={t((d) => d.plugins.devMode.label)}
          disabled={disabled}
        />
      </div>
      <p className={settingsStyles.helper}>{t((d) => d.plugins.devMode.helper)}</p>
      <p className={settingsStyles.helper}>{t((d) => d.plugins.devMode.loopbackNote)}</p>
      {on ? (
        <p className={`${settingsStyles.helper} ${styles.check}`}>
          <b className={styles.lead}>
            {passed ? t((d) => d.plugins.devMode.sandboxPassed) : t((d) => d.plugins.devMode.sandboxNotPassed)}
          </b>{" "}
          {passed ? t((d) => d.plugins.devMode.sandboxPassedBody) : t((d) => d.plugins.devMode.sandboxNotPassedBody)}
        </p>
      ) : null}
      {on && active ? (
        <div ref={panelRef} className={styles.log}>
          <PluginLogPanel rows={rows} activeId={active.id} onSelect={onSelectLog} />
        </div>
      ) : null}
    </SettingRow>
  );
}
