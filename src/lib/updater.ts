/*
 * The updater and relaunch calls, guarded for the no-shell case. The plugins load lazily, so their code
 * stays out of the first chunk and a plain browser preview never touches them. Outside the desktop runtime
 * a check rejects rather than resolving null, because null is the one answer that means up to date.
 */

// -- Library Imports --
import { isTauri } from "@tauri-apps/api/core";

// -- Type Imports --
import type { DownloadEvent, Update } from "@tauri-apps/plugin-updater";

/** Asks the release endpoint for a newer build: the Update, or null when this build is current. */
export async function checkForUpdate(): Promise<Update | null> {
  if (!isTauri()) throw new Error("Updates need the desktop app.");
  const { check } = await import("@tauri-apps/plugin-updater");
  return check();
}

/**
 * Downloads and installs `update`, streaming each download event to `onEvent`. On Windows the installer
 * takes over and the app exits before this resolves.
 */
export async function installUpdate(
  update: Update,
  onEvent: (event: DownloadEvent) => void,
): Promise<void> {
  await update.downloadAndInstall(onEvent);
}

/** Releases an update the user did not install. Best-effort. */
export function releaseUpdate(update: Update): void {
  void update.close().catch(() => {});
}

/** Restarts the app onto the installed build. A no-op outside the shell. */
export async function relaunchApp(): Promise<void> {
  if (!isTauri()) return;
  try {
    const { relaunch } = await import("@tauri-apps/plugin-process");
    await relaunch();
  } catch {
    // The installer already restarts the app on Windows; a refused relaunch leaves it to that.
  }
}

/** The running build's version, or null outside the shell. */
export async function appVersion(): Promise<string | null> {
  if (!isTauri()) return null;
  try {
    const { getVersion } = await import("@tauri-apps/api/app");
    return await getVersion();
  } catch {
    return null;
  }
}
