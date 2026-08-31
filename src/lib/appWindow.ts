/*
 * The window controls, guarded for the no-shell case. Outside the desktop runtime (a plain browser
 * preview) getCurrentWindow throws, so the window resolves lazily and every call no-ops when it is
 * absent. Keeps the Tauri coupling out of the title bar view.
 */

// -- Library Imports --
import { getCurrentWindow } from "@tauri-apps/api/window";

// -- Type Imports --
import type { Window } from "@tauri-apps/api/window";
import type { UnlistenFn } from "@tauri-apps/api/event";

/** The current window, or null outside the desktop shell where the runtime is missing. */
function appWindow(): Window | null {
  try {
    return getCurrentWindow();
  } catch {
    return null;
  }
}

/** Sends the window to the taskbar. */
export function minimizeWindow(): void {
  void appWindow()?.minimize();
}

/** Toggles between maximized and the prior size. */
export function toggleMaximizeWindow(): void {
  void appWindow()?.toggleMaximize();
}

/** Closes the window, ending the app. */
export function closeWindow(): void {
  void appWindow()?.close();
}

/** The maximized state, false when there is no window. */
export async function isWindowMaximized(): Promise<boolean> {
  const w = appWindow();
  if (!w) return false;
  try {
    return await w.isMaximized();
  } catch {
    return false;
  }
}

/** The window's visibility, true when there is no window so a preview never reads as hidden. */
export async function isWindowVisible(): Promise<boolean> {
  const w = appWindow();
  if (!w) return true;
  try {
    return await w.isVisible();
  } catch {
    return true;
  }
}

/** Subscribes to resize events; the returned unlisten is a no-op when there is no window. */
export async function onWindowResized(handler: () => void): Promise<UnlistenFn> {
  const w = appWindow();
  if (!w) return () => {};
  return w.onResized(() => handler());
}

/**
 * Subscribes to move events, handing the new physical top-left to the handler; the returned unlisten
 * is a no-op when there is no window. Physical pixels, to match what the Rust seat reads back.
 */
export async function onWindowMoved(
  handler: (pos: { x: number; y: number }) => void,
): Promise<UnlistenFn> {
  const w = appWindow();
  if (!w) return () => {};
  return w.onMoved((e) => handler({ x: e.payload.x, y: e.payload.y }));
}
