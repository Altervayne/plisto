/*
 * The updater's state machine, kept pure so the rules that matter are testable without the plugin: a
 * failed check is an error and never "up to date", only a null answer is; a skipped version stays quiet
 * while a newer one prompts again.
 */

/** The one announced update the prompt and Settings read. */
export interface UpdateInfo {
  version: string;
  notes: string;
}

export type UpdaterState =
  | { kind: "idle" }
  | { kind: "checking" }
  | { kind: "upToDate" }
  | { kind: "available"; update: UpdateInfo }
  // `progress` runs 0..1, or null while the download size is unknown.
  | { kind: "downloading"; update: UpdateInfo; progress: number | null }
  | { kind: "ready"; update: UpdateInfo }
  // `update` is set when the install failed, so the prompt can offer a retry on it.
  | { kind: "error"; message: string; update: UpdateInfo | null };

export type UpdaterEvent =
  | { type: "check" }
  | { type: "checked"; update: UpdateInfo | null }
  | { type: "checkFailed"; message: string }
  | { type: "download" }
  | { type: "progress"; progress: number | null }
  | { type: "installed" }
  | { type: "installFailed"; message: string };

export const IDLE: UpdaterState = { kind: "idle" };

/** The update a state carries, if any. */
export function updateOf(state: UpdaterState): UpdateInfo | null {
  switch (state.kind) {
    case "available":
    case "downloading":
    case "ready":
    case "error":
      return state.update;
    default:
      return null;
  }
}

/** The next state. An event that does not fit the current state leaves it unchanged. */
export function reduceUpdater(state: UpdaterState, event: UpdaterEvent): UpdaterState {
  switch (event.type) {
    case "check":
      // A running download is never interrupted by a second check.
      if (state.kind === "downloading" || state.kind === "ready") return state;
      return { kind: "checking" };
    case "checked":
      if (state.kind !== "checking") return state;
      return event.update ? { kind: "available", update: event.update } : { kind: "upToDate" };
    case "checkFailed":
      if (state.kind !== "checking") return state;
      return { kind: "error", message: event.message, update: null };
    case "download": {
      const update = updateOf(state);
      if (!update || state.kind === "downloading" || state.kind === "ready") return state;
      return { kind: "downloading", update, progress: null };
    }
    case "progress":
      if (state.kind !== "downloading") return state;
      return { ...state, progress: event.progress };
    case "installed":
      if (state.kind !== "downloading") return state;
      return { kind: "ready", update: state.update };
    case "installFailed":
      if (state.kind !== "downloading") return state;
      return { kind: "error", message: event.message, update: state.update };
  }
}

/**
 * Runs a check and turns its outcome into the event the machine takes. Only a resolved null reads as up
 * to date; a rejection of any kind is a failure carrying its reason.
 */
export async function runCheck(
  check: () => Promise<UpdateInfo | null>,
): Promise<Extract<UpdaterEvent, { type: "checked" | "checkFailed" }>> {
  try {
    return { type: "checked", update: await check() };
  } catch (error) {
    return { type: "checkFailed", message: errorMessage(error) };
  }
}

/** A readable reason from whatever a plugin call rejected with: a string, an Error, or neither. */
export function errorMessage(error: unknown): string {
  if (typeof error === "string" && error.trim()) return error;
  if (error instanceof Error && error.message) return error.message;
  return "Unknown error";
}

/**
 * Whether the startup check may be scheduled: the full app is up, the stored preferences have arrived (an
 * absent switch reads on only once they have), and auto-check is on. A manual check never asks this.
 */
export function startupCheckArmed(gate: { ready: boolean; prefsLoaded: boolean; autoCheck: boolean }): boolean {
  return gate.ready && gate.prefsLoaded && gate.autoCheck;
}

/** Whether `version` should open the prompt on its own, given the version the user skipped. */
export function shouldPrompt(version: string, skipped: string | undefined): boolean {
  return version !== skipped;
}
