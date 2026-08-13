/*
 * The native folder picker. Wraps the dialog plugin so callers get a plain path or null.
 * Outside the desktop shell (a plain browser) the plugin rejects; that is swallowed to null
 * so a preview render never crashes on a click.
 */

// -- Library Imports --
import { open } from "@tauri-apps/plugin-dialog";

/** Opens the folder picker, resolving with the chosen path or null when nothing is picked. */
export async function pickFolder(): Promise<string | null> {
  try {
    const selected = await open({ directory: true, multiple: false });
    return typeof selected === "string" ? selected : null;
  } catch {
    return null;
  }
}
