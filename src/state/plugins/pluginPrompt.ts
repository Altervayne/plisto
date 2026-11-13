/*
 * The plugin prompt queue as a store over the pure PromptQueue. A Plisto sheet holds the queue: while one
 * is open the head waits unanswered and shows again once it closes. The sheet check is a poll, since
 * no registry of open sheets exists, and it runs only while a prompt waits.
 */

// -- Library Imports --
import { create } from "zustand";

// -- State Imports --
import {
  closePrompt,
  currentPrompt,
  dropPromptPlugins,
  emptyPromptQueue,
  pushPrompt,
  setPromptHeld,
} from "./uiQueue";

// -- IPC Imports --
import { pluginUiAnswer } from "../../lib/ipc";

// -- Utils Imports --
import { plistoSheetOpen } from "../../lib/keyScope";

// -- Type Imports --
import type { PluginConfirmEvent, PromptQueue } from "./uiQueue";
import type { PluginUiEvent } from "../../types";

/** How often an open Plisto sheet is checked for while a prompt waits, in ms. */
export const SHEET_POLL_MS = 250;

interface PluginPromptStore {
  queue: PromptQueue;
  push: (event: PluginUiEvent) => void;
  /** Removes a prompt Rust closed, shown or waiting. */
  close: (requestId: string) => void;
  /** Removes the prompts of every plugin outside the live set. Rust closes them on its side. */
  dropPlugins: (liveIds: ReadonlySet<string>) => void;
  /**
   * Answers a prompt and removes it. A request no longer queued is ignored, so only the first answer
   * counts. A failed answer is dropped: Rust's own deadline ends the request.
   */
  answer: (requestId: string, value: boolean) => void;
}

let poll: ReturnType<typeof setInterval> | null = null;

export const usePluginPromptStore = create<PluginPromptStore>((set, get) => {
  const checkSheet = () => set((s) => ({ queue: setPromptHeld(s.queue, plistoSheetOpen()) }));

  /** Applies a new queue and runs the sheet poll only while it holds a prompt. */
  const apply = (queue: PromptQueue) => {
    if (queue === get().queue) return;
    if (queue.items.length === 0) {
      if (poll != null) clearInterval(poll);
      poll = null;
      set({ queue: setPromptHeld(queue, false) });
      return;
    }
    set({ queue });
    if (poll == null) {
      checkSheet();
      poll = setInterval(checkSheet, SHEET_POLL_MS);
    }
  };

  return {
    queue: emptyPromptQueue(),
    push: (event) => apply(pushPrompt(get().queue, event)),
    close: (requestId) => apply(closePrompt(get().queue, requestId)),
    dropPlugins: (liveIds) => apply(dropPromptPlugins(get().queue, liveIds)),
    answer: (requestId, value) => {
      if (!get().queue.items.some((item) => item.request_id === requestId)) return;
      pluginUiAnswer(requestId, { kind: "confirm", value }).catch(() => {});
      apply(closePrompt(get().queue, requestId));
    },
  };
});

// -- Selectors --

/** The prompt to show: the queue head, unless a Plisto sheet holds it. */
export const useCurrentPrompt = (): PluginConfirmEvent | null =>
  usePluginPromptStore((s) => currentPrompt(s.queue));
