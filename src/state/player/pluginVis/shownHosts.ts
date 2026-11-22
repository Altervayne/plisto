/*
 * The report of which visualizer hosts are shown, for the backend's process watch. The report is the
 * union of every visible plugin visualizer frame, the stage and any previews, sent whenever that set
 * changes and again on every beat while any frame is mounted, so a frame the watch starts tracking
 * later still gets a report. The backend refuses a report with any host it does not recognise, so only
 * hosts of the visualizer form are sent.
 */

// -- Type Imports --
import type { StageHandle } from "./frameCache";

// The hostname form of a kind's URL on the visualizer host.
const VIS_HOST = /^pv-[0-9a-f]{32}\.invalid$/;

/** A frame URL's visualizer host, or null for any other URL. */
export function hostOf(url: string | null): string | null {
  if (!url) return null;
  try {
    const host = new URL(url).hostname;
    return VIS_HOST.test(host) ? host : null;
  } catch {
    return null;
  }
}

/** The hosts of the visible frames, sorted and without repeats. */
export function shownHosts(handles: readonly Pick<StageHandle, "visible" | "url">[]): string[] {
  const hosts = new Set<string>();
  for (const handle of handles) {
    const host = handle.visible() ? hostOf(handle.url()) : null;
    if (host) hosts.add(host);
  }
  return [...hosts].sort();
}

export interface ShownReporterOptions {
  handles: () => readonly Pick<StageHandle, "visible" | "url">[];
  report: (hosts: string[]) => void;
}

/**
 * `sample` reports when the shown set changed since the last report. `beat` reports the set again while
 * any frame is mounted; with none mounted it only samples, so the last empty set goes out once.
 */
export function createShownReporter({ handles, report }: ShownReporterOptions) {
  let last: string | null = null;
  const send = (hosts: string[]) => {
    last = hosts.join(",");
    report(hosts);
  };
  const sample = () => {
    const hosts = shownHosts(handles());
    if (hosts.join(",") !== last) send(hosts);
  };
  return {
    sample,
    beat() {
      if (handles().length > 0) send(shownHosts(handles()));
      else sample();
    },
  };
}
