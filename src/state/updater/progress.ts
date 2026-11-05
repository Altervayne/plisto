/*
 * Download progress for the update prompt. The plugin reports one event per network chunk, far more often
 * than a bar needs to move, so the feed sums the chunks against the announced size and hands on at most
 * one value per interval, plus the final one.
 */

// -- Type Imports --
import type { DownloadEvent } from "@tauri-apps/plugin-updater";

/** The shortest gap between two values the feed hands on. */
export const PROGRESS_INTERVAL_MS = 100;

export interface DownloadTally {
  received: number;
  // Null when the server sent no size.
  total: number | null;
}

export const EMPTY_TALLY: DownloadTally = { received: 0, total: null };

/** Folds one download event into the running tally. */
export function tallyEvent(tally: DownloadTally, event: DownloadEvent): DownloadTally {
  switch (event.event) {
    case "Started":
      return { received: 0, total: event.data.contentLength ?? null };
    case "Progress":
      return { ...tally, received: tally.received + event.data.chunkLength };
    case "Finished":
      return tally.total != null ? { ...tally, received: tally.total } : tally;
  }
}

/** The tally as 0..1, or null when the size is unknown. */
export function tallyFraction(tally: DownloadTally): number | null {
  if (tally.total == null || tally.total <= 0) return null;
  return Math.min(1, tally.received / tally.total);
}

/**
 * A download-event handler that reports progress to `onProgress` at most once per interval. The first
 * event and Finished always report, so the bar starts and ends on the true value.
 */
export function createProgressFeed(
  onProgress: (progress: number | null) => void,
  now: () => number = Date.now,
): (event: DownloadEvent) => void {
  let tally = EMPTY_TALLY;
  let lastAt: number | null = null;
  return (event) => {
    tally = tallyEvent(tally, event);
    const at = now();
    if (event.event !== "Finished" && lastAt != null && at - lastAt < PROGRESS_INTERVAL_MS) return;
    lastAt = at;
    onProgress(tallyFraction(tally));
  };
}
