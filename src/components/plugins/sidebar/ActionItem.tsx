// -- Utils Imports --
import { NEUTRAL_ICON } from "./pluginNavIcons";

// -- i18n Imports --
import { useT } from "../../../i18n";

// -- Type Imports --
import type { PluginSidebarItem } from "../../../types";

// -- Style Imports --
import styles from "./PluginItems.module.css";

/** A declared action at rest: its label on a disabled row that does nothing. */
export function ActionItem({ item }: { item: PluginSidebarItem }) {
  const t = useT();
  const Icon = NEUTRAL_ICON;
  return (
    <button
      type="button"
      className={`${styles.row} ${styles.action}`}
      disabled
      title={t((d) => d.plugins.itemUnavailable)}
      aria-label={t((d) => d.plugins.itemUnavailableLabel, { label: item.label })}
    >
      <Icon size={17} strokeWidth={1.8} aria-hidden="true" />
      <span className={styles.label}>{item.label}</span>
    </button>
  );
}
