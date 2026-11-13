// -- Hook Imports --
import { useItemView } from "./useItemView";

// -- i18n Imports --
import { useT } from "../../../i18n";

// -- Type Imports --
import type { PluginSidebarItem } from "../../../types";

// -- Style Imports --
import styles from "./PluginItems.module.css";

/**
 * A declared status line. At rest it shows its label in quiet ink beside an empty icon column; once the
 * plugin sets it, a tone dot and the plugin's text, which is drawn as a text node only.
 */
export function StatusLineItem({ pluginId, item }: { pluginId: string; item: PluginSidebarItem }) {
  const t = useT();
  const view = useItemView(pluginId, item);
  if (view.kind === "hidden") return null;

  if (view.kind === "status") {
    const tone = view.tone === "accent" ? styles.dotAccent : view.tone === "warn" ? styles.dotWarn : "";
    return (
      <div className={`${styles.row} ${styles.status} ${styles.live} ${view.tone === "warn" ? styles.warn : ""}`}>
        <span className={styles.slot} aria-hidden="true">
          <span className={`${styles.dot} ${tone}`} />
        </span>
        <span className={styles.label}>{view.text}</span>
      </div>
    );
  }

  return (
    <div className={`${styles.row} ${styles.status}`} title={t((d) => d.plugins.itemUnavailable)}>
      <span className={styles.slot} aria-hidden="true" />
      <span className={styles.label}>{item.label}</span>
    </div>
  );
}
