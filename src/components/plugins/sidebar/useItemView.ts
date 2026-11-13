// -- State Imports --
import { useFramePhase } from "../../../state/plugins/frameHealth";
import { useItemPending, useItemState } from "../../../state/plugins/sidebarState";

// -- Utils Imports --
import { itemView } from "../../../state/plugins/sidebarModel";

// -- Type Imports --
import type { ItemView } from "../../../state/plugins/sidebarModel";
import type { PluginSidebarItem } from "../../../types";

/** What one declared item draws now: its live state, the plugin's frame phase and a pending press folded. */
export function useItemView(pluginId: string, item: PluginSidebarItem): ItemView {
  const live = useItemState(pluginId, item.id);
  const phase = useFramePhase(pluginId);
  const pending = useItemPending(pluginId, item.id);
  return itemView(item, live, phase, pending);
}
