/*
 * Holds the latest value of a fast input and commits it once the input pauses. `push` restarts the pause,
 * `flush` commits a held value now, and `cancel` drops it. The commit never runs without a held value.
 */

/** How long an input pauses before its value is committed. */
export const COMMIT_MS = 200;

export interface DebouncedWrite<T> {
  push: (value: T) => void;
  flush: () => void;
  cancel: () => void;
}

export function createDebouncedWrite<T>(commit: (value: T) => void, ms = COMMIT_MS): DebouncedWrite<T> {
  let held: { value: T } | null = null;
  let timer: ReturnType<typeof setTimeout> | null = null;
  const stop = () => {
    if (timer != null) clearTimeout(timer);
    timer = null;
  };
  const flush = () => {
    stop();
    const next = held;
    held = null;
    if (next) commit(next.value);
  };
  return {
    push(value) {
      held = { value };
      stop();
      timer = setTimeout(flush, ms);
    },
    flush,
    cancel() {
      stop();
      held = null;
    },
  };
}
