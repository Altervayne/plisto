/*
 * The loader behind a boot-time projection (roots, tracks, albums, playlists). Its first read never gives
 * up and never reads as "empty": it times out, retries, wakes on window focus or a library change, and
 * applies whichever answer lands first, a late one included. The store hears only two flags: `ready`
 * (a read has landed) and `stalled` (it has not landed after STALL_MS). Only `start()` waits on the first
 * read. Every other entry returns at once while it runs, so a stuck read can never hold a caller; a
 * reload asked for meanwhile runs once right after the first read lands. Every read takes a sequence
 * number and applies only if no later-issued read applied before it, so a slow answer never overwrites a
 * fresher one.
 */

// -- Utils Imports --
import { reportBootRead } from "../lib/bootReadLog";
import type { BootRead } from "../lib/bootReadLog";
import { withRetry } from "../lib/withRetry";
import type { AttemptInfo, RetryRun } from "../lib/withRetry";

/** How long a first read may stay unanswered before the projection reads as stalled. */
export const STALL_MS = 10_000;

export interface LoadFlags {
  ready: boolean;
  stalled: boolean;
}

export interface ProjectionLoaderOptions<T> {
  /** The read's name in the boot log. */
  name: BootRead;
  read: () => Promise<T>;
  /** Writes one landed read into the store. A throw counts as a failed read. */
  apply: (value: T) => void;
  /** Reports every change of the flags. */
  onFlags: (flags: LoadFlags) => void;
}

export interface ProjectionLoader {
  /** Begins the first read, or joins the one running. Resolves once it has landed, or on `reset()`; never rejects. */
  start: () => Promise<void>;
  /** A store's own load: a reload once ready; before that see `reload`. */
  load: () => Promise<boolean>;
  /**
   * A read after the first. Retries 12 times unless `retry` is false, and returns false when it fails,
   * leaving the loaded rows alone. Before the first read lands it never waits: it starts that read if
   * needed, asks for a reload once it lands, and returns false. It does not wake the read.
   */
  reload: (retry?: boolean) => Promise<boolean>;
  /** Cuts the first read's wait short. No effect once ready. */
  wake: () => void;
  isReady: () => boolean;
  /** Back to not ready with every read and timer dropped; a waiting `start()` resolves. */
  reset: () => void;
  /** A `reset()` that also refuses every read until `release()`: no wake, focus or reload can land rows. */
  hold: () => void;
  /** Ends a hold with a fresh reset, so nothing read during it is trusted. The caller then starts it. */
  release: () => void;
}

export function createProjectionLoader<T>(options: ProjectionLoaderOptions<T>): ProjectionLoader {
  let ready = false;
  let counter = 0;
  let applied = 0;
  // Bumped by reset: a reload issued before it ignores its answer.
  let epoch = 0;
  let wantReload = false;
  // True once an attempt of the running first read failed, timed out or answered late.
  let troubled = false;
  let run: RetryRun | null = null;
  let first: Promise<void> | null = null;
  let resolveFirst: (() => void) | null = null;
  let held = false;
  let stallTimer: ReturnType<typeof setTimeout> | null = null;

  const wake = (): void => run?.wake();

  const release = (): void => {
    if (stallTimer) clearTimeout(stallTimer);
    stallTimer = null;
    if (typeof window !== "undefined") window.removeEventListener("focus", wake);
  };

  const settleFirst = (): void => {
    resolveFirst?.();
    resolveFirst = null;
  };

  // Applies an answer unless a later-issued read already did.
  const land = (value: T, seq: number): void => {
    if (seq <= applied) return;
    options.apply(value);
    applied = seq;
  };

  // The first answer: apply it, then drop the leftover attempts so none can overwrite a newer state.
  const landFirst = (value: T, seq: number, info: AttemptInfo): void => {
    land(value, seq);
    if (ready) return;
    ready = true;
    // A first read that needed no retry leaves no line.
    if (troubled) reportBootRead(options.name, "recovered", info.attempt, info.elapsedMs);
    troubled = false;
    release();
    run?.cancel();
    run = null;
    options.onFlags({ ready: true, stalled: false });
    settleFirst();
    if (wantReload) {
      wantReload = false;
      void reload();
    }
  };

  const start = (): Promise<void> => {
    if (ready || held) return Promise.resolve();
    if (first) return first;
    first = new Promise<void>((resolve) => {
      resolveFirst = resolve;
    });
    stallTimer = setTimeout(() => {
      stallTimer = null;
      if (!ready) options.onFlags({ ready: false, stalled: true });
    }, STALL_MS);
    if (typeof window !== "undefined") window.addEventListener("focus", wake);
    troubled = false;
    run = withRetry(options.read, {
      nextSeq: () => ++counter,
      onAnswer: landFirst,
      onEvent: (event) => {
        troubled = true;
        reportBootRead(options.name, event.kind, event.attempt, event.elapsedMs, event.error);
      },
    });
    return first;
  };

  const reload = async (retry = true): Promise<boolean> => {
    if (held) return false;
    if (!ready) {
      wantReload = true;
      void start();
      return false;
    }
    const mine = epoch;
    const seq = ++counter;
    try {
      const value = await (retry ? withRetry(options.read) : options.read());
      if (mine !== epoch) return false;
      land(value, seq);
      return true;
    } catch {
      return false;
    }
  };

  const reset = (): void => {
    epoch++;
    run?.cancel();
    run = null;
    release();
    ready = false;
    applied = 0;
    wantReload = false;
    troubled = false;
    first = null;
    settleFirst();
    options.onFlags({ ready: false, stalled: false });
  };

  return {
    start,
    load: () => reload(),
    reload,
    wake,
    isReady: () => ready,
    reset,
    hold: () => {
      reset();
      held = true;
    },
    release: () => {
      held = false;
      reset();
    },
  };
}
