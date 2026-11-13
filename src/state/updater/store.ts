/*
 * The updater store: the machine's live state, whether the prompt is up, whether the details modal is open
 * and from where, and the actions behind the startup check, the Settings button, the prompt and the modal. The plugin's Update handle is a backend resource, so
 * it lives beside the store rather than in it; a newer check releases the one it replaces.
 */

// -- Library Imports --
import { create } from "zustand";

// -- State Imports --
import { PREF_KEYS, usePreferencesStore } from "../preferences/store";
import { IDLE, errorMessage, reduceUpdater, runCheck, shouldPrompt, updateOf } from "./machine";
import { createProgressFeed } from "./progress";

// -- Utils Imports --
import { checkForUpdate, installUpdate, relaunchApp, releaseUpdate } from "../../lib/updater";

// -- Type Imports --
import type { Update } from "@tauri-apps/plugin-updater";
import type { UpdateInfo, UpdaterEvent, UpdaterState } from "./machine";

/** Where a check came from: the quiet one after boot, or the Settings button. */
export type CheckSource = "startup" | "manual";

/** Where the details modal was opened from: the prompt hides while it is open and returns after. */
export type DetailsOrigin = "prompt" | "settings";

interface UpdaterStore {
  state: UpdaterState;
  promptOpen: boolean;
  details: DetailsOrigin | null;
  check: (source: CheckSource) => Promise<void>;
  install: () => Promise<void>;
  later: () => void;
  skip: () => void;
  openDetails: (origin: DetailsOrigin) => void;
  closeDetails: () => void;
}

let held: Update | null = null;

/** Swaps in the handle from a fresh check, releasing the one it replaces. */
function hold(next: Update | null): void {
  if (held && held !== next) releaseUpdate(held);
  held = next;
}

export const useUpdaterStore = create<UpdaterStore>((set, get) => {
  const dispatch = (event: UpdaterEvent) => set((s) => ({ state: reduceUpdater(s.state, event) }));

  return {
    state: IDLE,
    promptOpen: false,
    details: null,

    check: async (source) => {
      const kind = get().state.kind;
      if (kind === "checking" || kind === "downloading" || kind === "ready") return;
      dispatch({ type: "check" });
      // The check drops the announced update, so a modal open on it has nothing left to show.
      set({ details: null });
      const outcome = await runCheck(async (): Promise<UpdateInfo | null> => {
        const update = await checkForUpdate();
        hold(update);
        return update
          ? {
              version: update.version,
              currentVersion: update.currentVersion,
              notes: update.body ?? "",
              date: update.date ?? null,
            }
          : null;
      });
      // The startup check stays silent on failure: offline at launch is not worth a word.
      if (outcome.type === "checkFailed" && source === "startup") {
        set({ state: IDLE });
        return;
      }
      dispatch(outcome);
      if (outcome.type !== "checked" || !outcome.update) return;
      const skipped = usePreferencesStore.getState().getPreference(PREF_KEYS.updaterSkipped);
      if (source === "manual" || shouldPrompt(outcome.update.version, skipped)) {
        set({ promptOpen: true });
      }
    },

    install: async () => {
      const update = held;
      if (!update) return;
      dispatch({ type: "download" });
      try {
        await installUpdate(update, createProgressFeed((progress) => dispatch({ type: "progress", progress })));
        dispatch({ type: "installed" });
        await relaunchApp();
      } catch (error) {
        dispatch({ type: "installFailed", message: errorMessage(error) });
      }
    },

    // Closes the prompt and the modal for this session only; nothing is stored, so the next launch asks again.
    later: () => {
      const { state } = get();
      if (state.kind === "downloading" || state.kind === "ready") return;
      set({ promptOpen: false, details: null });
    },

    // Closes the prompt and the modal and stores the version, so it stays quiet until a newer one ships.
    skip: () => {
      const { state } = get();
      if (state.kind === "downloading" || state.kind === "ready") return;
      const update = updateOf(state);
      if (update) usePreferencesStore.getState().setPreference(PREF_KEYS.updaterSkipped, update.version);
      set({ promptOpen: false, details: null });
    },

    openDetails: (origin) => {
      if (updateOf(get().state)) set({ details: origin });
    },

    // Decides nothing: a modal opened from the prompt hands the screen back to it.
    closeDetails: () => set({ details: null }),
  };
});

// -- Selectors (narrow: one value or one stable action each) --

export const useUpdaterState = (): UpdaterState => useUpdaterStore((s) => s.state);
export const useUpdatePromptOpen = (): boolean => useUpdaterStore((s) => s.promptOpen);
export const useCheckForUpdate = () => useUpdaterStore((s) => s.check);
export const useInstallUpdate = () => useUpdaterStore((s) => s.install);
export const useLaterUpdate = () => useUpdaterStore((s) => s.later);
export const useSkipUpdate = () => useUpdaterStore((s) => s.skip);
/** Whether the user skipped exactly this version. */
export const useIsSkippedUpdate = (version: string): boolean =>
  usePreferencesStore((s) => s.values[PREF_KEYS.updaterSkipped] === version);
export const useUpdateDetails = (): DetailsOrigin | null => useUpdaterStore((s) => s.details);
export const useOpenUpdateDetails = () => useUpdaterStore((s) => s.openDetails);
export const useCloseUpdateDetails = () => useUpdaterStore((s) => s.closeDetails);
