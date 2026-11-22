/*
 * Plisto's own notices about a plugin, from `plugins:notice`: kept off the stores like the queue nudge,
 * as a module emitter with one dismiss timer. One notice shows at a time; a repeat of the one already
 * showing is the same notice and is ignored, and a different one replaces it. The last notice stays in
 * the snapshot after it hides, so the pill can fade out with its content.
 */

// -- Framework Imports --
import { useSyncExternalStore } from "react";

// -- Library Imports --
import { listen } from "@tauri-apps/api/event";

// -- State Imports --
import { TOAST_VISIBLE_MS } from "./uiQueue";

// -- Type Imports --
import type { PluginNotice } from "../../types";

/** The event the backend emits once when it turns a plugin off after repeated crashes. */
export const PLUGINS_NOTICE = "plugins:notice";

/** What the pill renders: the notice, or the last one while it fades, and whether it shows. */
export interface PluginNoticeView {
  notice: PluginNotice | null;
  visible: boolean;
}

let snapshot: PluginNoticeView = { notice: null, visible: false };
let timer: ReturnType<typeof setTimeout> | null = null;
const listeners = new Set<() => void>();

function publish(next: PluginNoticeView): void {
  if (next.notice === snapshot.notice && next.visible === snapshot.visible) return;
  snapshot = next;
  listeners.forEach((notify) => notify());
}

/** Hides the showing notice. */
export function dismissPluginNotice(): void {
  if (timer != null) clearTimeout(timer);
  timer = null;
  publish({ notice: snapshot.notice, visible: false });
}

function sameNotice(a: PluginNotice, b: PluginNotice): boolean {
  if (a.id !== b.id || a.kind !== b.kind) return false;
  if (a.kind !== "visualizer_stopped" || b.kind !== "visualizer_stopped") return true;
  return a.visualizer === b.visualizer && a.cause === b.cause;
}

/** Shows a notice, unless the same one is already showing. */
export function showPluginNotice(notice: PluginNotice): void {
  const current = snapshot.notice;
  if (snapshot.visible && current && sameNotice(current, notice)) return;
  if (timer != null) clearTimeout(timer);
  timer = setTimeout(dismissPluginNotice, TOAST_VISIBLE_MS);
  publish({ notice, visible: true });
}

/** Starts listening for notices and returns the teardown. The notice host is the only caller. */
export function startPluginNoticeListener(): () => void {
  let alive = true;
  let unlisten: (() => void) | null = null;
  listen<PluginNotice>(PLUGINS_NOTICE, (event) => showPluginNotice(event.payload))
    .then((fn) => {
      if (alive) unlisten = fn;
      else fn();
    })
    .catch(() => {});
  return () => {
    alive = false;
    unlisten?.();
  };
}

/** Clears the held notice. For tests, which share the module. */
export function resetPluginNotice(): void {
  if (timer != null) clearTimeout(timer);
  timer = null;
  publish({ notice: null, visible: false });
}

function subscribe(notify: () => void): () => void {
  listeners.add(notify);
  return () => listeners.delete(notify);
}

/** The notice state as it stands. */
export function currentPluginNotice(): PluginNoticeView {
  return snapshot;
}

/** The live notice state for the pill. */
export function usePluginNotice(): PluginNoticeView {
  return useSyncExternalStore(subscribe, currentPluginNotice, currentPluginNotice);
}
