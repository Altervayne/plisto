/*
 * The scan-issues store: whether the review sheet is open, the standing count of unreadable files, the
 * reason filter, and the paged list. Every read goes through the boot retry, and a read that still fails
 * lands in an `error` status rather than a zero or an empty list, so a failure never reads as "all
 * clear". The bulk actions (retry, dismiss) follow the active filter and refresh the list and the count
 * when they finish.
 */

// -- Library Imports --
import { create } from "zustand";

// -- IPC Imports --
import {
  scanIssuesClear,
  scanIssuesCount,
  scanIssuesList,
  scanIssuesOpenLog,
  scanIssuesRetry,
  scanIssuesText,
} from "../lib/ipc";

// -- Utils Imports --
import { withRetry } from "../lib/withRetry";

// -- Type Imports --
import type {
  ScanIssue,
  ScanIssuePage,
  ScanIssueReason,
  ScanIssueRetryProgress,
} from "../types";

/** Rows fetched per page of the list. */
export const ISSUES_PAGE_SIZE = 200;

/** What the backend says when a retry meets a running scan. */
const SCAN_RUNNING = "a scan is already running";

/** Where a read stands. `error` keeps whatever was loaded before. */
export type IssuesStatus = "idle" | "loading" | "ready" | "error";

/**
 * The one calm line the sheet shows about the last action. It clears on the next action. A retrying
 * notice carries `progress` once the first tick has arrived.
 */
export type IssueNotice =
  | { kind: "retrying"; n: number; progress?: ScanIssueRetryProgress }
  | { kind: "result"; cleared: number; stillFailing: number }
  | { kind: "scanRunning" }
  | { kind: "noLog" }
  | { kind: "unavailable" }
  | { kind: "failed" };

/** Row counts per reason over the whole table; a reason with no rows is absent. */
export type ReasonCounts = Partial<Record<ScanIssueReason, number>>;

interface ScanIssuesStore {
  open: boolean;
  openSheet: () => void;
  closeSheet: () => void;

  // Null until the first count lands; stays null after a failed first read.
  count: number | null;
  countStatus: IssuesStatus;
  refreshCount: () => Promise<void>;

  // The reason the list and the bulk actions are narrowed to; null is every reason.
  filter: ScanIssueReason | null;
  setFilter: (reason: ScanIssueReason | null) => Promise<void>;
  byReason: ReasonCounts;

  rows: ScanIssue[];
  // Rows matching the filter, however many are loaded.
  total: number;
  listStatus: IssuesStatus;
  // Replaces the cache with the first page.
  loadFirst: () => Promise<void>;
  // Appends the next page; a no-op while a read runs or when every row is held.
  loadMore: () => Promise<void>;

  notice: IssueNotice | null;
  clearNotice: () => void;
  // Retry one row, or everything the filter shows.
  retryOne: (id: number) => Promise<void>;
  retryShown: () => Promise<void>;
  // Folds a retry tick into the running retry's notice; ignored when no retry runs.
  applyRetryProgress: (tick: ScanIssueRetryProgress) => void;
  // Dismiss one row, or everything the filter shows.
  dismissOne: (id: number) => Promise<void>;
  dismissShown: () => Promise<void>;
  // The plain text of everything the filter shows, or null when the read failed.
  readCopyText: () => Promise<string | null>;
  openLog: () => Promise<void>;
  // Re-reads the count, and the list when the sheet is open, after rows were removed elsewhere.
  refreshStanding: () => Promise<void>;
}

/** The filter that still has rows: a filter whose reason ran out falls back to every reason. */
export function liveFilter(
  filter: ScanIssueReason | null,
  byReason: ReasonCounts,
): ScanIssueReason | null {
  return filter && (byReason[filter] ?? 0) > 0 ? filter : null;
}

/** Whether a rejection is the backend refusing a retry because a scan is running. */
export function isScanRunning(error: unknown): boolean {
  const text = typeof error === "string" ? error : error instanceof Error ? error.message : "";
  return text.includes(SCAN_RUNNING);
}

/** Reads the first page, then more pages until `depth` rows are held or the list ends. */
async function readUpTo(filter: ScanIssueReason | null, depth: number): Promise<ScanIssuePage> {
  let page = await withRetry(() => scanIssuesList(0, ISSUES_PAGE_SIZE, filter));
  const rows = [...page.rows];
  while (rows.length < depth && rows.length < page.total) {
    const offset = rows.length;
    const next = await withRetry(() => scanIssuesList(offset, ISSUES_PAGE_SIZE, filter));
    if (next.rows.length === 0) break;
    rows.push(...next.rows);
    page = next;
  }
  return { ...page, rows };
}

// A read that finishes after a newer one started is dropped, so a stale page never overwrites a fresh one.
let readSeq = 0;

export const useScanIssuesStore = create<ScanIssuesStore>((set, get) => {
  // Re-reads the list holding at least `depth` rows, and drops a filter whose reason ran out.
  const load = async (depth: number): Promise<void> => {
    const mine = ++readSeq;
    set({ listStatus: "loading" });
    try {
      let filter = get().filter;
      let page = await readUpTo(filter, depth);
      const live = liveFilter(filter, page.by_reason);
      if (live !== filter) {
        filter = live;
        page = await readUpTo(filter, depth);
      }
      if (mine !== readSeq) return;
      set({ rows: page.rows, total: page.total, byReason: page.by_reason, filter, listStatus: "ready" });
    } catch {
      if (mine === readSeq) set({ listStatus: "error" });
    }
  };

  const refreshAll = async (): Promise<void> => {
    await Promise.all([load(get().rows.length), get().refreshCount()]);
  };

  const retrying = (): boolean => get().notice?.kind === "retrying";

  const runRetry = async (ids: number[] | null, n: number): Promise<void> => {
    if (retrying()) return;
    set({ notice: { kind: "retrying", n } });
    try {
      const result = await scanIssuesRetry(ids, ids ? null : get().filter);
      // Nothing retried means the folder's drive is offline.
      set({
        notice:
          result.retried === 0
            ? { kind: "unavailable" }
            : { kind: "result", cleared: result.cleared, stillFailing: result.retried - result.cleared },
      });
    } catch (error) {
      set({ notice: { kind: isScanRunning(error) ? "scanRunning" : "failed" } });
      return;
    }
    await refreshAll();
  };

  // Resolves false when the dismiss did not go through.
  const runDismiss = async (ids: number[] | null): Promise<boolean> => {
    if (retrying()) return true;
    set({ notice: null });
    try {
      await scanIssuesClear(ids, ids ? null : get().filter);
    } catch {
      set({ notice: { kind: "failed" } });
      return false;
    }
    await refreshAll();
    return true;
  };

  return {
    open: false,
    openSheet: () => set({ open: true }),
    // A reopen starts from a real read, never from the rows of the last visit.
    closeSheet: () =>
      set({
        open: false,
        filter: null,
        notice: null,
        rows: [],
        total: 0,
        byReason: {},
        listStatus: "idle",
      }),

    count: null,
    countStatus: "idle",
    refreshCount: async () => {
      set({ countStatus: "loading" });
      try {
        set({ count: await withRetry(scanIssuesCount), countStatus: "ready" });
      } catch {
        set({ countStatus: "error" });
      }
    },

    filter: null,
    setFilter: async (reason) => {
      if (retrying()) return;
      set({ filter: reason, notice: null });
      await load(0);
    },
    byReason: {},

    rows: [],
    total: 0,
    listStatus: "idle",
    loadFirst: () => load(0),
    loadMore: async () => {
      const { rows, total, listStatus, filter } = get();
      if (listStatus === "loading" || rows.length >= total) return;
      const mine = ++readSeq;
      set({ listStatus: "loading" });
      try {
        const page = await withRetry(() => scanIssuesList(rows.length, ISSUES_PAGE_SIZE, filter));
        if (mine !== readSeq) return;
        set({
          rows: [...rows, ...page.rows],
          total: page.total,
          byReason: page.by_reason,
          listStatus: "ready",
        });
      } catch {
        if (mine === readSeq) set({ listStatus: "error" });
      }
    },

    notice: null,
    clearNotice: () => {
      if (!retrying()) set({ notice: null });
    },
    retryOne: (id) => runRetry([id], 1),
    retryShown: () => runRetry(null, get().total),
    applyRetryProgress: (tick) => {
      const { notice } = get();
      if (notice?.kind !== "retrying") return;
      // Progress never steps back, so a tick that arrives out of order is dropped.
      if (notice.progress && tick.done < notice.progress.done) return;
      set({ notice: { ...notice, progress: tick } });
    },
    dismissOne: async (id) => {
      // The row leaves at once; the refresh that follows brings the counts into line.
      const depth = get().rows.length;
      set((s) => ({ rows: s.rows.filter((r) => r.id !== id), total: Math.max(0, s.total - 1) }));
      // A failed dismiss brings the row back by re-reading.
      if (!(await runDismiss([id]))) await load(depth);
    },
    dismissShown: async () => {
      await runDismiss(null);
    },
    readCopyText: async () => {
      try {
        return await scanIssuesText(get().filter);
      } catch {
        set({ notice: { kind: "failed" } });
        return null;
      }
    },
    openLog: async () => {
      set({ notice: null });
      try {
        if (!(await scanIssuesOpenLog())) set({ notice: { kind: "noLog" } });
      } catch {
        set({ notice: { kind: "failed" } });
      }
    },
    refreshStanding: async () => {
      await Promise.all([get().open ? load(get().rows.length) : Promise.resolve(), get().refreshCount()]);
    },
  };
});

export const useScanIssuesOpen = (): boolean => useScanIssuesStore((s) => s.open);
export const useOpenScanIssues = (): (() => void) => useScanIssuesStore((s) => s.openSheet);
export const useCloseScanIssues = (): (() => void) => useScanIssuesStore((s) => s.closeSheet);
/** The standing count, or null before the first read lands. */
export const useScanIssuesCount = (): number | null => useScanIssuesStore((s) => s.count);
