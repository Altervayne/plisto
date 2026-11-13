/*
 * The plugin toast queue, kept off the stores like the player's queue nudge: a module emitter over the
 * pure ToastQueue with one show timer. Only the head shows; it answers dismissed after TOAST_VISIBLE_MS
 * unless it is answered or closed first. The last shown toast stays in the snapshot after the queue
 * empties, so the pill can fade out with its content.
 */

// -- Framework Imports --
import { useSyncExternalStore } from "react";

// -- State Imports --
import {
  TOAST_VISIBLE_MS,
  closeToast,
  currentToast,
  dropToastPlugins,
  emptyToastQueue,
  pushToast,
} from "./uiQueue";

// -- IPC Imports --
import { pluginUiAnswer } from "../../lib/ipc";

// -- Type Imports --
import type { PluginToastEvent } from "./uiQueue";
import type { PluginUiEvent } from "../../types";

/** What the pill renders: the toast to show, or the last one while it fades, and whether it shows. */
export interface PluginToastView {
  toast: PluginToastEvent | null;
  visible: boolean;
}

let queue = emptyToastQueue();
let shown: PluginToastEvent | null = null;
let timer: ReturnType<typeof setTimeout> | null = null;
let snapshot: PluginToastView = { toast: null, visible: false };
const listeners = new Set<() => void>();

/** Restarts the show timer when the head changed and publishes the new snapshot. */
function settle(): void {
  const head = currentToast(queue);
  if (head?.request_id !== shown?.request_id) {
    if (timer != null) clearTimeout(timer);
    timer = null;
    if (head) {
      const requestId = head.request_id;
      timer = setTimeout(() => answerPluginToast(requestId, false), TOAST_VISIBLE_MS);
    }
  }
  shown = head;
  const toast = head ?? snapshot.toast;
  const visible = head != null;
  if (toast === snapshot.toast && visible === snapshot.visible) return;
  snapshot = { toast, visible };
  listeners.forEach((notify) => notify());
}

/** Queues a toast event. Other kinds and a request id already queued are ignored. */
export function pushPluginToast(event: PluginUiEvent): void {
  queue = pushToast(queue, event);
  settle();
}

/** Removes a toast Rust closed, shown or waiting. */
export function closePluginToast(requestId: string): void {
  queue = closeToast(queue, requestId);
  settle();
}

/** Removes the toasts of every plugin outside the live set. Rust closes them on its side. */
export function dropPluginToasts(liveIds: ReadonlySet<string>): void {
  queue = dropToastPlugins(queue, liveIds);
  settle();
}

/**
 * Answers a toast and removes it. A request no longer queued is ignored, so a late timer or a second
 * press answers nothing. A failed answer is dropped: Rust's own deadline ends the request.
 */
export function answerPluginToast(requestId: string, action: boolean): void {
  if (!queue.items.some((item) => item.request_id === requestId)) return;
  pluginUiAnswer(requestId, { kind: "toast", action }).catch(() => {});
  closePluginToast(requestId);
}

function subscribe(notify: () => void): () => void {
  listeners.add(notify);
  return () => listeners.delete(notify);
}

/** The current toast state, outside React. */
export function getPluginToast(): PluginToastView {
  return snapshot;
}

/** The live toast state for the pill. */
export function usePluginToast(): PluginToastView {
  return useSyncExternalStore(subscribe, getPluginToast, getPluginToast);
}
