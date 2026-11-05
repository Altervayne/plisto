/*
 * The idle fade behind ambient mode's chrome: armed on creation, it reports faded after `delayMs` with
 * no wake, and a wake un-fades at once and re-arms. The timer functions are injected so the timing is
 * tested without a clock.
 */

export interface Timers {
  set: (fn: () => void, ms: number) => number;
  clear: (id: number) => void;
}

export interface IdleTimer {
  // Activity: un-fades if faded, and restarts the countdown.
  wake: () => void;
  dispose: () => void;
}

const WINDOW_TIMERS: Timers = {
  set: (fn, ms) => window.setTimeout(fn, ms),
  clear: (id) => window.clearTimeout(id),
};

/** Starts an idle countdown that calls `onChange` only when the faded state flips. */
export function createIdleTimer(
  delayMs: number,
  onChange: (faded: boolean) => void,
  timers: Timers = WINDOW_TIMERS,
): IdleTimer {
  let faded = false;
  let id: number | null = null;

  const arm = () => {
    if (id != null) timers.clear(id);
    id = timers.set(() => {
      id = null;
      faded = true;
      onChange(true);
    }, delayMs);
  };

  arm();

  return {
    wake() {
      if (faded) {
        faded = false;
        onChange(false);
      }
      arm();
    },
    dispose() {
      if (id != null) timers.clear(id);
      id = null;
    },
  };
}
