// -- State Imports --
import { showPluginNotice } from "../../state/plugins/pluginNotice";

/**
 * Asks Rust to take the output back from its holder and, only when one was released, raises Plisto's
 * notice for it. A rejected command reads as not released: the block keeps following the status, which
 * is the truth. `holderId` is null when no holder is known.
 */
export async function returnOutput(release: () => Promise<boolean>, holderId: string | null): Promise<boolean> {
  const released = await release().catch(() => false);
  if (released) showPluginNotice({ id: holderId, kind: "takeover_returned" });
  return released;
}
