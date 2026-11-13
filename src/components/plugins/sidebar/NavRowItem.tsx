// -- Component Imports --
import { NavItem } from "../../shell/NavItem";
import { PluginChips } from "../PluginChips";

// -- Hook Imports --
import { useItemView } from "./useItemView";

// -- Utils Imports --
import { navIconFor } from "./pluginNavIcons";

// -- Type Imports --
import type { PluginSidebarItem } from "../../../types";

/**
 * A declared nav item: a regular rail row that opens the plugin's page on the item's route. The plugin
 * may set its label and one chip, or hide it.
 */
export function NavRowItem({
  pluginId,
  item,
  active,
  onOpen,
}: {
  pluginId: string;
  item: PluginSidebarItem;
  active: boolean;
  onOpen: (route: string | null) => void;
}) {
  const view = useItemView(pluginId, item);
  if (view.kind === "hidden") return null;

  const Icon = navIconFor(item.icon);
  const live = view.kind === "nav" ? view : null;
  return (
    <NavItem
      icon={<Icon size={17} strokeWidth={1.8} />}
      label={live?.label ?? item.label}
      chips={live?.chip ? <PluginChips chips={[live.chip]} /> : undefined}
      active={active}
      onClick={() => onOpen(item.route)}
    />
  );
}
