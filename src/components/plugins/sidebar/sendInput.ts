// -- State Imports --
import { hasLiveFrame, sendSidebar } from "../../../state/plugins/pluginHost";
import { useSidebarState } from "../../../state/plugins/sidebarState";
import { usePluginsStore } from "../../../state/plugins/store";

// -- IPC Imports --
import { pluginSidebarInput } from "../../../lib/ipc";

/**
 * Reports a press on a toggle (`value` set) or an action (`value` null) and hands the minted gesture to
 * the plugin's frame. A UI plugin with no live frame never reaches Rust; a native plugin always does,
 * because Rust delivers the click to its process itself. A press that cannot be delivered, or that Rust
 * refuses, ends the item's pending state at once; an accepted one leaves it for the plugin's own update
 * or the pending deadline to end.
 */
export async function sendInput(pluginId: string, itemId: string, value: boolean | null): Promise<void> {
  const { clearPending } = useSidebarState.getState();
  const native = usePluginsStore.getState().rows.find((row) => row.id === pluginId)?.tier === "native";
  if (!native && !hasLiveFrame(pluginId)) {
    clearPending(pluginId, itemId);
    return;
  }
  try {
    const reply = await pluginSidebarInput(pluginId, itemId, value);
    // Accepted with no frame delivery is a plugin Rust reaches itself: nothing to post.
    if (!reply.accepted || (reply.frame && !sendSidebar(pluginId, reply.frame))) {
      clearPending(pluginId, itemId);
    }
  } catch {
    clearPending(pluginId, itemId);
  }
}
