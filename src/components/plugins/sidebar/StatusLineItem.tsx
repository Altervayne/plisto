// -- i18n Imports --
import { useT } from "../../../i18n";

// -- Type Imports --
import type { PluginSidebarItem } from "../../../types";

// -- Style Imports --
import styles from "./PluginItems.module.css";

/** A declared status line at rest: its label in quiet ink beside an empty icon column. */
export function StatusLineItem({ item }: { item: PluginSidebarItem }) {
  const t = useT();
  return (
    <div className={`${styles.row} ${styles.status}`} title={t((d) => d.plugins.itemUnavailable)}>
      <span className={styles.slot} aria-hidden="true" />
      <span className={styles.label}>{item.label}</span>
    </div>
  );
}
