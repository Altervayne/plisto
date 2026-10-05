/*
 * The active view's hooks for the shell's Ctrl+F and Ctrl+A. A view registers what it can do while it
 * is mounted, and the shell reads the latest registration when the key lands. Registrations stack, so a
 * view mounting over another hands the keys back to it on unmount.
 */

// -- Framework Imports --
import { useEffect, useRef } from "react";

/** What the active view does on the shell's find and select-all keys. A missing entry is unsupported. */
export interface ViewKeys {
  focusSearch?: () => void;
  selectAll?: () => void;
}

/** A live handle on a view's keys: the view refreshes `current` on every render. */
export interface ViewKeysSource {
  readonly current: ViewKeys;
}

const sources: ViewKeysSource[] = [];

/** Pushes a view's keys on top. The returned release is idempotent. */
export function registerViewKeys(source: ViewKeysSource): () => void {
  sources.push(source);
  return () => {
    const index = sources.lastIndexOf(source);
    if (index >= 0) sources.splice(index, 1);
  };
}

/** The keys of the most recently mounted view, or null when no view registered any. */
export function activeViewKeys(): ViewKeys | null {
  return sources[sources.length - 1]?.current ?? null;
}

/**
 * Registers the calling view's keys for its lifetime. The handlers ride a ref, so a re-render with fresh
 * closures never re-registers and the view keeps its place in the stack.
 */
export function useViewKeys(keys: ViewKeys): void {
  const ref = useRef(keys);
  ref.current = keys;
  useEffect(() => registerViewKeys(ref), []);
}
