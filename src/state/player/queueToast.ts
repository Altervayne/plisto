/*
 * The queue nudge, kept off the store so a menu append never touches the ticking player slice. A
 * module-level emitter holds the notice and one dismiss timer; the pill subscribes through
 * useSyncExternalStore. Repeated appends while the pill shows add to the tally and restart the window, so
 * a burst reads as one pill with the cumulative count. The notice survives the exit fade and is replaced
 * only when a fresh one opens. The same pill carries the short confirmations of album entries (added,
 * unpacked) and where a play-next landed.
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
  | { kind: "playsAfter"; title: string }
  | { kind: "playsAfterAlbum" }
  | { kind: "albumAdded"; name: string }
  | { kind: "unpacked"; count: number };

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

/**
 * Says where a play-next landed when the engine placed it after the playing row's kept block. Replaces the
 * append tally the play-next just raised; an outcome that landed elsewhere (or none) leaves it be.
 */
export function announceAfterBlock(outcome: { afterBlock: boolean } | undefined): void {
  if (outcome?.afterBlock) show({ kind: "playsAfterAlbum" });
}

/** Announces that an album was added to the named playlist as a kept entry. */
export function albumAdded(name: string): void {
  show({ kind: "albumAdded", name });
}

/** Announces that an album entry became `count` track rows. */
export function unpacked(count: number): void {
  show({ kind: "unpacked", count });
}

function subscribe(notify: () => void): () => void {
  listeners.add(notify);
  return () => listeners.delete(notify);
}

/** The live toast state for the pill. */
export function useQueueToast(): QueueToast {
  return useSyncExternalStore(subscribe, () => snapshot, () => snapshot);
}
