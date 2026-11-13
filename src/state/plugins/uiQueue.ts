/*
 * The two queues behind the plugin toast and prompt, as pure reducers. A queue holds what Rust still has
 * open, in arrival order; only the head is ever shown. The head leaves when it is answered, closed by
 * Rust, or its plugin stops being live, so a held or hidden head is never lost.
 */

// -- Type Imports --
import type { PluginUiEvent } from "../../types";

/** How long one toast shows before it answers dismissed, in ms. */
export const TOAST_VISIBLE_MS = 4000;

export type PluginToastEvent = Extract<PluginUiEvent, { kind: "toast" }>;
export type PluginConfirmEvent = Extract<PluginUiEvent, { kind: "confirm" }>;

export interface ToastQueue {
  items: readonly PluginToastEvent[];
}

export interface PromptQueue {
  items: readonly PluginConfirmEvent[];
  /** True while a Plisto sheet is open; the head stays queued but does not show. */
  held: boolean;
}

export const emptyToastQueue = (): ToastQueue => ({ items: [] });

export const emptyPromptQueue = (): PromptQueue => ({ items: [], held: false });

// -- Toasts --

/** Adds a toast event at the tail. Other kinds and a request id already queued are ignored. */
export function pushToast(queue: ToastQueue, event: PluginUiEvent): ToastQueue {
  if (event.kind !== "toast") return queue;
  if (queue.items.some((item) => item.request_id === event.request_id)) return queue;
  return { items: [...queue.items, event] };
}

/** Removes the toast with this request id, shown or waiting. */
export function closeToast(queue: ToastQueue, requestId: string): ToastQueue {
  const items = queue.items.filter((item) => item.request_id !== requestId);
  return items.length === queue.items.length ? queue : { items };
}

/** Removes every toast whose plugin is not in the live set. */
export function dropToastPlugins(queue: ToastQueue, liveIds: ReadonlySet<string>): ToastQueue {
  const items = queue.items.filter((item) => liveIds.has(item.id));
  return items.length === queue.items.length ? queue : { items };
}

/** The one toast to show, or null. */
export function currentToast(queue: ToastQueue): PluginToastEvent | null {
  return queue.items[0] ?? null;
}

/** Drops the shown toast so the next one takes its place. */
export function advanceToast(queue: ToastQueue): ToastQueue {
  return queue.items.length === 0 ? queue : { items: queue.items.slice(1) };
}

// -- Prompts --

/** Adds a prompt event at the tail. Other kinds and a request id already queued are ignored. */
export function pushPrompt(queue: PromptQueue, event: PluginUiEvent): PromptQueue {
  if (event.kind !== "confirm") return queue;
  if (queue.items.some((item) => item.request_id === event.request_id)) return queue;
  return { ...queue, items: [...queue.items, event] };
}

/** Removes the prompt with this request id, shown or waiting. */
export function closePrompt(queue: PromptQueue, requestId: string): PromptQueue {
  const items = queue.items.filter((item) => item.request_id !== requestId);
  return items.length === queue.items.length ? queue : { ...queue, items };
}

/** Removes every prompt whose plugin is not in the live set. */
export function dropPromptPlugins(queue: PromptQueue, liveIds: ReadonlySet<string>): PromptQueue {
  const items = queue.items.filter((item) => liveIds.has(item.id));
  return items.length === queue.items.length ? queue : { ...queue, items };
}

/** Sets whether a Plisto sheet holds the queue. The head is kept either way. */
export function setPromptHeld(queue: PromptQueue, held: boolean): PromptQueue {
  return queue.held === held ? queue : { ...queue, held };
}

/** The prompt to show: the head, unless a Plisto sheet holds the queue. */
export function currentPrompt(queue: PromptQueue): PluginConfirmEvent | null {
  return queue.held ? null : (queue.items[0] ?? null);
}

/** Drops the answered head so the next prompt takes its place. */
export function advancePrompt(queue: PromptQueue): PromptQueue {
  return queue.items.length === 0 ? queue : { ...queue, items: queue.items.slice(1) };
}
