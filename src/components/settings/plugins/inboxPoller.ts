/*
 * The scheduling core behind useInbox, free of React and the DOM so it runs under fake timers. A read
 * fires on start, on a window wake (focus or the document turning visible) and on a quiet interval that
 * only ticks while the document is visible. Reads never overlap, and a failure streak logs once.
 */

// -- Type Imports --
import type { PluginInboxItem } from "../../../types";

/** The quiet re-read cadence while the document is visible. */
export const INBOX_POLL_MS = 3000;

/** True when both lists hold the same items in the same order. */
export function sameInboxItems(a: PluginInboxItem[], b: PluginInboxItem[]): boolean {
  if (a === b) return true;
  if (a.length !== b.length) return false;
  return a.every((x, i) => x.name === b[i].name && x.path === b[i].path && x.kind === b[i].kind);
}

/** What the poller needs from the page, injected so tests need no DOM. */
export interface InboxPollerEnv {
  isVisible: () => boolean;
  /** Calls onWake when the window regains focus or the document becomes visible. Returns the unsubscribe. */
  onWake: (onWake: () => void) => () => void;
}

export interface InboxPollerOptions {
  read: () => Promise<PluginInboxItem[]>;
  onList: (list: PluginInboxItem[]) => void;
  onError: (error: unknown) => void;
  env: InboxPollerEnv;
  intervalMs?: number;
}

/** Starts polling with an immediate read. Returns a stop function; a read resolving after stop is dropped. */
export function startInboxPoller(options: InboxPollerOptions): () => void {
  const { read, onList, onError, env, intervalMs = INBOX_POLL_MS } = options;
  let stopped = false;
  let inFlight = false;
  let failing = false;

  const refresh = () => {
    if (stopped || inFlight) return;
    inFlight = true;
    read()
      .then((list) => {
        failing = false;
        if (!stopped) onList(list);
      })
      .catch((e: unknown) => {
        // Log the first failure of a streak only; a later success re-arms it.
        if (!failing && !stopped) onError(e);
        failing = true;
      })
      .finally(() => {
        inFlight = false;
      });
  };

  const timer = setInterval(() => {
    if (env.isVisible()) refresh();
  }, intervalMs);
  const offWake = env.onWake(refresh);
  refresh();

  return () => {
    stopped = true;
    clearInterval(timer);
    offWake();
  };
}

/** The real page: window focus plus document visibility. */
export const browserInboxEnv: InboxPollerEnv = {
  isVisible: () => document.visibilityState === "visible",
  onWake: (onWake) => {
    const onVisibility = () => {
      if (document.visibilityState === "visible") onWake();
    };
    window.addEventListener("focus", onWake);
    document.addEventListener("visibilitychange", onVisibility);
    return () => {
      window.removeEventListener("focus", onWake);
      document.removeEventListener("visibilitychange", onVisibility);
    };
  },
};
