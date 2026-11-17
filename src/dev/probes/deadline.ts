/*
 * Bounds one probe run: it ends as done, timed out or stopped, whichever comes first, even when the
 * probe's own promise never settles. A result that arrives after the run ended is dropped, so a partial
 * outcome can never overwrite "timed out" or "stopped".
 */

export const DEFAULT_TIMEOUT_MS = 60_000;
const MIN_TIMEOUT_MS = 1_000;
const MAX_TIMEOUT_MS = 600_000;

export type RunEnd<T> = { kind: "done"; value: T } | { kind: "timeout" } | { kind: "stopped" };

/** The deadline for a module's run: its own `timeoutMs` clamped to a sane range, else the default. */
export function deadlineMs(requested: number | undefined): number {
  if (requested === undefined || !Number.isFinite(requested)) return DEFAULT_TIMEOUT_MS;
  return Math.min(MAX_TIMEOUT_MS, Math.max(MIN_TIMEOUT_MS, requested));
}

/** How long a probe that was ended early gets to finish its own cleanup before the shell resets for it. */
export const CLEANUP_GRACE_MS = 5_000;

export interface GuardedRun<T> {
  end: RunEnd<T>;
  /** False when the probe's own promise had not settled within the grace time after an early end. */
  clean: boolean;
}

/**
 * `runBounded`, then, when the run ended early (timeout or stop), waits for the probe's own promise to settle
 * for up to `graceMs`, so its cleanup is not still in flight when the caller goes on to the next probe.
 * `onEnd` is called at once with how the run ended, before that wait.
 */
export async function runGuarded<T>(
  start: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
  stop: AbortSignal,
  graceMs = CLEANUP_GRACE_MS,
  onEnd?: (end: RunEnd<T>) => void,
): Promise<GuardedRun<T>> {
  let underlying: Promise<unknown> = Promise.resolve();
  const end = await runBounded(
    (signal) => {
      underlying = start(signal);
      return underlying as Promise<T>;
    },
    timeoutMs,
    stop,
  );
  onEnd?.(end);
  if (end.kind === "done") return { end, clean: true };
  let timer: ReturnType<typeof setTimeout> | undefined;
  const grace = new Promise<boolean>((resolve) => {
    timer = setTimeout(() => resolve(false), graceMs);
  });
  const settled = underlying.then(
    () => true,
    () => true,
  );
  const clean = await Promise.race([settled, grace]);
  clearTimeout(timer);
  return { end, clean };
}

/**
 * Runs `start` with a signal that aborts on timeout or stop, and settles on the first of: the result, the
 * deadline, or `stop` aborting. A rejection before either end rejects; one after is swallowed.
 */
export function runBounded<T>(
  start: (signal: AbortSignal) => Promise<T>,
  timeoutMs: number,
  stop: AbortSignal,
): Promise<RunEnd<T>> {
  return new Promise((resolve, reject) => {
    const inner = new AbortController();
    let ended = false;
    const end = (result: RunEnd<T>) => {
      if (ended) return;
      ended = true;
      clearTimeout(timer);
      stop.removeEventListener("abort", onStop);
      if (result.kind !== "done") inner.abort();
      resolve(result);
    };
    const onStop = () => end({ kind: "stopped" });
    const timer = setTimeout(() => end({ kind: "timeout" }), timeoutMs);
    if (stop.aborted) return end({ kind: "stopped" });
    stop.addEventListener("abort", onStop, { once: true });
    start(inner.signal).then(
      (value) => end({ kind: "done", value }),
      (error) => {
        if (ended) return;
        ended = true;
        clearTimeout(timer);
        stop.removeEventListener("abort", onStop);
        reject(error);
      },
    );
  });
}
