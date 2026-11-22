/*
 * Lets a recording find the ticks a stage mount sends. A mount binds its tap under its own `stats`
 * function, which is also the one its stage handle lists, so the handle leads to its mount's tap without
 * either knowing the other.
 */

// -- Type Imports --
import type { Tick } from "../../../visRuntime/protocol";

/** Calls `listener` with every tick the mount sends to its frame until the returned release runs. */
export type FeedTap = (listener: (tick: Tick) => void) => () => void;

const taps = new WeakMap<object, FeedTap>();

export function bindFeedTap(key: object, tap: FeedTap): void {
  taps.set(key, tap);
}

/** The tap bound under `key`, or null. */
export function feedTapOf(key: object): FeedTap | null {
  return taps.get(key) ?? null;
}
