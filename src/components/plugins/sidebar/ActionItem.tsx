// -- Component Imports --
import { Tooltip } from "../../common/Tooltip/Tooltip";
import { TruncatedText } from "../../common/TruncatedText/TruncatedText";

// -- Hook Imports --
import { useItemView } from "./useItemView";

// -- Utils Imports --
import { NEUTRAL_ICON, navIconFor } from "./pluginNavIcons";
import { sendInput } from "./sendInput";

// -- i18n Imports --
import { useT } from "../../../i18n";

// -- Type Imports --
import type { PluginSidebarItem } from "../../../types";

// -- Style Imports --
import styles from "./PluginItems.module.css";

/**
 * A declared action. At rest its label sits on a disabled row that does nothing. Live, it is a button
 * with the plugin's label or the declared one; a press reports a click the plugin can use as a gesture.
 */
export function ActionItem({
  pluginId,
  pluginName,
  item,
}: {
  pluginId: string;
  pluginName: string;
  item: PluginSidebarItem;
}) {
  const t = useT();
  const view = useItemView(pluginId, item);
  if (view.kind === "hidden") return null;

  if (view.kind === "action") {
    const Icon = navIconFor(item.icon);
    return (
      <Tooltip label={view.enabled ? undefined : t((d) => d.plugins.ui.itemWaiting, { name: pluginName })}>
        <button
          type="button"
          className={`${styles.row} ${styles.action} ${styles.live}`}
          disabled={!view.enabled}
          onClick={() => void sendInput(pluginId, item.id, null)}
        >
          <Icon size={17} strokeWidth={1.8} aria-hidden="true" />
          <TruncatedText text={view.label} className={styles.label} />
        </button>
      </Tooltip>
    );
  }

  const Icon = NEUTRAL_ICON;
  return (
    <Tooltip label={t((d) => d.plugins.itemUnavailable)}>
      <button
        type="button"
        className={`${styles.row} ${styles.action}`}
        disabled
        aria-label={t((d) => d.plugins.itemUnavailableLabel, { label: item.label })}
      >
        <Icon size={17} strokeWidth={1.8} aria-hidden="true" />
        <span className={styles.label}>{item.label}</span>
      </button>
    </Tooltip>
  );
}
