/*
 * The boot-read retry. A first read at launch can reject before the backend's managed state is ready:
 * the window fires its first invokes while setup() is still standing up the resident state. A boot read
 * retries with backoff so a swallowed early rejection never reads as "empty" and strands the launch on
 * the wrong path. An empty result is not a rejection, so a genuinely empty read still resolves at once.
 *
 * Two forms. A number of attempts gives up and rethrows. An options object never gives up: each attempt
 * has a timeout, a timed-out attempt stays alive so its late answer still counts, and at most two are
 * in flight so a blocked backend is not buried under queued reads.
 */

const FIRST_TIMEOUT_MS = 10_000;
const MAX_TIMEOUT_MS = 60_000;
const MAX_IN_FLIGHT = 2;
const RAMP_ATTEMPTS = 12;
const SLOW_RETRY_MS = 5_000;

export interface RetryOptions<T> {
  /** Issues the sequence number of the next attempt. Higher means issued later. */
  nextSeq: () => number;
  /**
   * Receives every answer, a timed-out attempt's late one included, with its sequence number. The first
   * call that returns ends the run; a throw counts as a failed attempt.
   */
  onAnswer: (value: T, seq: number, info: AttemptInfo) => void;
  /** Reports each failed, timed-out and late attempt. A throw is ignored. */
  onEvent?: (event: RetryEvent) => void;
}

/** Where an attempt sits in its run: 1-based attempt number and ms since the run started. */
export interface AttemptInfo {
  attempt: number;
  elapsedMs: number;
}

export interface RetryEvent extends AttemptInfo {
  /** failed: rejected. timeout: gave up waiting. late: answered after its timeout. */
  kind: "failed" | "timeout" | "late";
  error?: unknown;
}

export interface RetryRun {
  /** Cuts a backoff sleep short and issues an attempt now, if the in-flight cap allows. */
  wake: () => void;
  /** Stops issuing and drops any answer still to come. */
  cancel: () => void;
}

/** Retries a read a fixed number of times with a growing delay, then rethrows its last error. */
export function withRetry<T>(fn: () => Promise<T>, attempts?: number): Promise<T>;
/** Retries a read until it answers, with no give-up. */
export function withRetry<T>(fn: () => Promise<T>, options: RetryOptions<T>): RetryRun;
export function withRetry<T>(
  fn: () => Promise<T>,
  second: number | RetryOptions<T> = 12,
): Promise<T> | RetryRun {
  return typeof second === "number" ? retryCounted(fn, second) : retryForever(fn, second);
}

async function retryCounted<T>(fn: () => Promise<T>, attempts: number): Promise<T> {
  for (let i = 0; ; i++) {
    try {
      return await fn();
    } catch (e) {
      if (i >= attempts - 1) throw e;
      await new Promise((r) => setTimeout(r, Math.min(1000, 250 * (i + 1))));
    }
  }
}

function retryForever<T>(fn: () => Promise<T>, options: RetryOptions<T>): RetryRun {
  let timeoutMs = FIRST_TIMEOUT_MS;
  let inFlight = 0;
  let failures = 0;
  let answered = false;
  let stopped = false;
  let sleep: ReturnType<typeof setTimeout> | null = null;
  const timers = new Set<ReturnType<typeof setTimeout>>();
  const startedAt = Date.now();
  let issued = 0;

  const report = (kind: RetryEvent["kind"], attempt: number, error?: unknown): void => {
    if (stopped || !options.onEvent) return;
    try {
      options.onEvent({ kind, attempt, elapsedMs: Date.now() - startedAt, error });
    } catch {
      // A reporting fault never touches the read.
    }
  };

  const done = (): boolean => answered || stopped;

  // Issues an attempt now unless the cap is full; a settling attempt pumps again.
  const pump = (): void => {
    if (sleep) {
      clearTimeout(sleep);
      sleep = null;
    }
    if (done() || inFlight >= MAX_IN_FLIGHT) return;
    attempt();
  };

  const retryLater = (): void => {
    if (done() || sleep) return;
    const delay = failures < RAMP_ATTEMPTS ? Math.min(1000, 250 * (failures + 1)) : SLOW_RETRY_MS;
    failures++;
    sleep = setTimeout(pump, delay);
  };

  const attempt = (): void => {
    const seq = options.nextSeq();
    const number = ++issued;
    inFlight++;
    let settled = false;
    let timedOut = false;
    let abandoned = false;
    let abandonTimer: ReturnType<typeof setTimeout> | null = null;
    const timer = setTimeout(() => {
      timers.delete(timer);
      if (settled) return;
      timedOut = true;
      report("timeout", number);
      timeoutMs = Math.min(MAX_TIMEOUT_MS, timeoutMs * 2);
      // A silent attempt gives its slot back after a further wait, so a backend that drops reads is
      // still retried. Its late answer is accepted all the same.
      abandonTimer = setTimeout(() => {
        if (abandonTimer) timers.delete(abandonTimer);
        if (settled) return;
        abandoned = true;
        inFlight--;
        pump();
      }, MAX_TIMEOUT_MS);
      timers.add(abandonTimer);
      pump();
    }, timeoutMs);
    timers.add(timer);

    // Settles the attempt, returning its slot unless it was already given back.
    const settle = (): void => {
      settled = true;
      clearTimeout(timer);
      timers.delete(timer);
      if (abandonTimer) {
        clearTimeout(abandonTimer);
        timers.delete(abandonTimer);
      }
      if (!abandoned) inFlight--;
    };

    // A failure of a timed-out attempt only frees its slot: the timeout already started the next one.
    const fail = (): void => {
      if (timedOut) pump();
      else retryLater();
    };

    let read: Promise<T>;
    try {
      read = Promise.resolve(fn());
    } catch (e) {
      read = Promise.reject(e);
    }
    read.then(
      (value) => {
        settle();
        if (stopped) return;
        if (timedOut) report("late", number);
        try {
          options.onAnswer(value, seq, { attempt: number, elapsedMs: Date.now() - startedAt });
          answered = true;
        } catch (e) {
          report("failed", number, e);
          fail();
        }
      },
      (e) => {
        settle();
        if (stopped) return;
        report("failed", number, e);
        fail();
      },
    );
  };

  pump();

  return {
    wake: pump,
    cancel: () => {
      stopped = true;
      if (sleep) clearTimeout(sleep);
      sleep = null;
      for (const t of timers) clearTimeout(t);
      timers.clear();
    },
  };
}
