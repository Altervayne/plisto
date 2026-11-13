// -- i18n Imports --
import { useT } from "../../../i18n";

// -- Type Imports --
import type { PluginSidebarItem } from "../../../types";

// -- Style Imports --
import styles from "./PluginItems.module.css";

/** A declared progress bar at rest: its label over an empty track. */
export function ProgressItem({ item }: { item: PluginSidebarItem }) {
  const t = useT();
  return (
    <div className={styles.progress} title={t((d) => d.plugins.itemUnavailable)}>
      <span className={styles.label}>{item.label}</span>
      <div className={styles.track} aria-hidden="true" />
    </div>
  );
}
