// -- Component Imports --
import { Switch } from "../../common/Switch/Switch";

// -- Utils Imports --
import { NEUTRAL_ICON } from "./pluginNavIcons";

// -- i18n Imports --
import { useT } from "../../../i18n";

// -- Type Imports --
import type { PluginSidebarItem } from "../../../types";

// -- Style Imports --
import styles from "./PluginItems.module.css";

/** A declared toggle at rest: its label beside a switch that is off and cannot be pressed. */
export function ToggleItem({ item }: { item: PluginSidebarItem }) {
  const t = useT();
  const Icon = NEUTRAL_ICON;
  return (
    <div className={styles.row} title={t((d) => d.plugins.itemUnavailable)}>
      <Icon size={17} strokeWidth={1.8} aria-hidden="true" />
      <span className={styles.label}>{item.label}</span>
      <Switch
        checked={false}
        onChange={() => {}}
        label={t((d) => d.plugins.itemUnavailableLabel, { label: item.label })}
        disabled
      />
    </div>
  );
}
