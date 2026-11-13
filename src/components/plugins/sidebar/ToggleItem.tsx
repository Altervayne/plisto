// -- Component Imports --
import { Switch } from "../../common/Switch/Switch";

// -- State Imports --
import { useSidebarState } from "../../../state/plugins/sidebarState";

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
 * A declared toggle. At rest its switch is off and cannot be pressed. Live, the switch shows the position
 * the plugin set; a press asks the plugin and leaves the knob where it is, dimmed, until the plugin
 * answers or the wait ends, so the rail never shows a position the plugin did not set.
 */
export function ToggleItem({
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

  if (view.kind === "toggle") {
    const Icon = navIconFor(item.icon);
    return (
      <div
        className={`${styles.row} ${styles.live}`}
        title={view.enabled ? undefined : t((d) => d.plugins.ui.itemWaiting, { name: pluginName })}
      >
        <Icon size={17} strokeWidth={1.8} aria-hidden="true" />
        <span className={styles.label}>{item.label}</span>
        <Switch
          checked={view.on}
          onChange={(next) => {
            useSidebarState.getState().setPending(pluginId, item.id);
            void sendInput(pluginId, item.id, next);
          }}
          label={item.label}
          disabled={!view.enabled}
          pending={view.pending}
        />
      </div>
    );
  }

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
