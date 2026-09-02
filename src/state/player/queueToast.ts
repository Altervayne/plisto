/*
 * The "added to queue" nudge, kept off the store so a menu append never touches the ticking player
 * slice. A module-level emitter holds the running count and one dismiss timer; the pill subscribes
 * through useSyncExternalStore. Menu hammering coalesces: each append while the pill still shows adds
 * to the tally and restarts the window, so a burst reads as one pill with the cumulative count rather
 * than a stack. The count survives the exit fade (the pill holds its last value) and resets only when a
 * fresh append opens a new pill.
 */

// -- Framework Imports --
import { useSyncExternalStore } from "react";

/** How long the pill stays before it fades, restarted on every append inside the window. */
const VISIBLE_MS = 2000;

/** What the pill renders: the cumulative count and whether it is showing. */
export interface QueueToast {
  count: number;
  visible: boolean;
}

let count = 0;
let visible = false;
let timer: number | null = null;
let snapshot: QueueToast = { count, visible };
const listeners = new Set<() => void>();

function emit(): void {
  snapshot = { count, visible };
  listeners.forEach((notify) => notify());
}

function dismiss(): void {
  timer = null;
  visible = false;
  emit();
}

/**
 * Announces `n` freshly queued tracks. Accumulates onto a pill already showing, or opens a new one from
 * `n`, and restarts the dismiss window either way. A non-positive count is a no-op.
 */
export function added(n: number): void {
  if (n <= 0) return;
  count = visible ? count + n : n;
  visible = true;
  if (timer != null) clearTimeout(timer);
  timer = window.setTimeout(dismiss, VISIBLE_MS);
  emit();
}

function subscribe(notify: () => void): () => void {
  listeners.add(notify);
  return () => listeners.delete(notify);
}

/** The live toast state for the pill. */
export function useQueueToast(): QueueToast {
  return useSyncExternalStore(subscribe, () => snapshot, () => snapshot);
}
