/*
 * The system opener, guarded for the no-shell case. Outside the desktop runtime (a plain browser
 * preview) the plugin rejects, so every call swallows the error to a no-op and never crashes a
 * preview render. Keeps the Tauri coupling out of the views.
 */

// -- Library Imports --
import { openPath, revealItemInDir } from "@tauri-apps/plugin-opener";

/** Opens a folder in the system file manager. A no-op when the desktop runtime is absent. */
export async function openFolder(path: string): Promise<void> {
  try {
    await openPath(path);
  } catch {
    // No shell (a browser preview) or the path is gone: nothing to open.
  }
}

/** Reveals a file in the system file manager, selected in its folder. A no-op without the desktop runtime. */
export async function revealFile(path: string): Promise<void> {
  try {
    await revealItemInDir(path);
  } catch {
    // No shell (a browser preview) or the path is gone: nothing to reveal.
  }
}
