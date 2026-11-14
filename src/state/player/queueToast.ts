/*
 * The queue nudge, kept off the store so a menu append never touches the ticking player slice. A
 * module-level emitter holds the notice and one dismiss timer; the pill subscribes through
 * useSyncExternalStore. Repeated appends while the pill shows add to the tally and restart the window, so
 * a burst reads as one pill with the cumulative count. The notice survives the exit fade and is replaced
 * only when a fresh one opens.
 */

// -- Framework Imports --
import { useSyncExternalStore } from "react";

/** How long the pill stays before it fades, restarted on every notice inside the window. */
const VISIBLE_MS = 2000;

/** What the pill says: a tally of appended tracks, or a line about a plugin stream's parked queue. */
export type QueueNotice =
  | { kind: "added"; count: number }
  | { kind: "cleared"; name: string }
  | { kind: "clearedPlain" }
  | { kind: "playsAfter"; title: string };

/** What the pill renders: the notice and whether it is showing. */
export interface QueueToast {
  notice: QueueNotice;
  visible: boolean;
}

let notice: QueueNotice = { kind: "added", count: 0 };
let visible = false;
let timer: number | null = null;
let snapshot: QueueToast = { notice, visible };
const listeners = new Set<() => void>();

function emit(): void {
  snapshot = { notice, visible };
  listeners.forEach((notify) => notify());
}

function dismiss(): void {
  timer = null;
  visible = false;
  emit();
}

function show(next: QueueNotice): void {
  notice = next;
  visible = true;
  if (timer != null) clearTimeout(timer);
  timer = window.setTimeout(dismiss, VISIBLE_MS);
  emit();
}

/**
 * Announces `n` freshly queued tracks. Accumulates onto a tally already showing, or opens a new one from
 * `n`, and restarts the dismiss window either way. A non-positive count is a no-op.
 */
export function added(n: number): void {
  if (n <= 0) return;
  const running = visible && notice.kind === "added" ? notice.count : 0;
  show({ kind: "added", count: running + n });
}

/** Announces that the parked queue was emptied and the named stream plays on; no name, no second sentence. */
export function cleared(name: string): void {
  show(name ? { kind: "cleared", name } : { kind: "clearedPlain" });
}

/** Announces that a track was placed after the parked one, with nothing started. */
export function playsAfter(title: string): void {
  show({ kind: "playsAfter", title });
}

function subscribe(notify: () => void): () => void {
  listeners.add(notify);
  return () => listeners.delete(notify);
}

/** The live toast state for the pill. */
export function useQueueToast(): QueueToast {
  return useSyncExternalStore(subscribe, () => snapshot, () => snapshot);
}
