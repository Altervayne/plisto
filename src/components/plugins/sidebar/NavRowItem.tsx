// -- Component Imports --
import { NavItem } from "../../shell/NavItem";

// -- Utils Imports --
import { navIconFor } from "./pluginNavIcons";

// -- Type Imports --
import type { PluginSidebarItem } from "../../../types";

/** A declared nav item: a regular rail row that opens the plugin's page on the item's route. */
export function NavRowItem({
  item,
  active,
  onOpen,
}: {
  item: PluginSidebarItem;
  active: boolean;
  onOpen: (route: string | null) => void;
}) {
  const Icon = navIconFor(item.icon);
  return (
    <NavItem
      icon={<Icon size={17} strokeWidth={1.8} />}
      label={item.label}
      active={active}
      onClick={() => onOpen(item.route)}
    />
  );
}
