// -- Test Imports --
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// -- Unit Imports --
import { ISSUES_PAGE_SIZE, isScanRunning, liveFilter, useScanIssuesStore } from "./scanIssues";

// -- IPC Imports --
import {
  scanIssuesClear,
  scanIssuesCount,
  scanIssuesList,
  scanIssuesOpenLog,
  scanIssuesRetry,
  scanIssuesText,
} from "../lib/ipc";

// -- Type Imports --
import type { ScanIssue, ScanIssuePage } from "../types";

vi.mock("../lib/ipc", () => ({
  scanIssuesCount: vi.fn(),
  scanIssuesList: vi.fn(),
  scanIssuesRetry: vi.fn(),
  scanIssuesClear: vi.fn(),
  scanIssuesText: vi.fn(),
  scanIssuesOpenLog: vi.fn(),
}));

const issue = (id: number): ScanIssue => ({
  id,
  path: `C:\\music\\${id}.mp3`,
  root_id: 1,
  track_id: id,
  kind: "tags",
  reason: "corrupt_or_unsupported",
  detail: "bad header",
  first_seen: 1,
  last_seen: 2,
});

const page = (total: number, ids: number[], by: ScanIssuePage["by_reason"] = {}): ScanIssuePage => ({
  total,
  rows: ids.map(issue),
  by_reason: by,
});

const initial = useScanIssuesStore.getState();
const state = () => useScanIssuesStore.getState();

beforeEach(() => {
  vi.useFakeTimers();
  useScanIssuesStore.setState(initial, true);
  for (const fn of [
    scanIssuesCount,
    scanIssuesList,
    scanIssuesRetry,
    scanIssuesClear,
    scanIssuesText,
    scanIssuesOpenLog,
  ]) {
    vi.mocked(fn).mockReset();
  }
});

afterEach(() => {
  vi.useRealTimers();
});

describe("scan issues sheet", () => {
  it("opens and closes, and closing drops the filter and the notice", () => {
    state().openSheet();
    expect(state().open).toBe(true);
    useScanIssuesStore.setState({ filter: "in_use", notice: { kind: "failed" } });
    state().closeSheet();
    expect(state()).toMatchObject({ open: false, filter: null, notice: null });
  });
});

describe("refreshCount", () => {
  it("retries a rejected read and lands the count", async () => {
    vi.mocked(scanIssuesCount).mockRejectedValueOnce(new Error("early")).mockResolvedValue(7);
    const read = state().refreshCount();
    await vi.runAllTimersAsync();
    await read;
    expect(scanIssuesCount).toHaveBeenCalledTimes(2);
    expect(state()).toMatchObject({ count: 7, countStatus: "ready" });
  });

  it("reports an error, never a zero, when every attempt fails", async () => {
    vi.mocked(scanIssuesCount).mockRejectedValue(new Error("down"));
    const read = state().refreshCount();
    await vi.runAllTimersAsync();
    await read;
    expect(state()).toMatchObject({ count: null, countStatus: "error" });
  });

  it("keeps the last known count through a failed refresh", async () => {
    useScanIssuesStore.setState({ count: 4, countStatus: "ready" });
    vi.mocked(scanIssuesCount).mockRejectedValue(new Error("down"));
    const read = state().refreshCount();
    await vi.runAllTimersAsync();
    await read;
    expect(state()).toMatchObject({ count: 4, countStatus: "error" });
  });

  it("reads a genuine zero as ready", async () => {
    vi.mocked(scanIssuesCount).mockResolvedValue(0);
    await state().refreshCount();
    expect(state()).toMatchObject({ count: 0, countStatus: "ready" });
  });
});

describe("the issue list", () => {
  it("loads the first page, its total and the reason counts", async () => {
    vi.mocked(scanIssuesList).mockResolvedValue(
      page(300, [1, 2], { corrupt_or_unsupported: 280, in_use: 20 }),
    );
    await state().loadFirst();
    expect(scanIssuesList).toHaveBeenCalledWith(0, ISSUES_PAGE_SIZE, null);
    expect(state()).toMatchObject({ total: 300, listStatus: "ready" });
    expect(state().byReason).toEqual({ corrupt_or_unsupported: 280, in_use: 20 });
    expect(state().rows).toHaveLength(2);
  });

  it("appends the next page and keeps the total", async () => {
    vi.mocked(scanIssuesList)
      .mockResolvedValueOnce(page(3, [1, 2]))
      .mockResolvedValueOnce(page(3, [3]));
    await state().loadFirst();
    await state().loadMore();
    expect(scanIssuesList).toHaveBeenLastCalledWith(2, ISSUES_PAGE_SIZE, null);
    expect(state().rows.map((r) => r.id)).toEqual([1, 2, 3]);
    expect(state().total).toBe(3);
  });

  it("does not read past the last row", async () => {
    vi.mocked(scanIssuesList).mockResolvedValue(page(1, [1]));
    await state().loadFirst();
    await state().loadMore();
    expect(scanIssuesList).toHaveBeenCalledTimes(1);
  });

  it("flags an error and keeps the rows held when a page fails", async () => {
    vi.mocked(scanIssuesList).mockResolvedValueOnce(page(5, [1]));
    await state().loadFirst();
    vi.mocked(scanIssuesList).mockRejectedValue(new Error("down"));
    const more = state().loadMore();
    await vi.runAllTimersAsync();
    await more;
    expect(state()).toMatchObject({ listStatus: "error", total: 5 });
    expect(state().rows).toHaveLength(1);
  });

  it("reports an error, not an empty list, when the first read fails", async () => {
    vi.mocked(scanIssuesList).mockRejectedValue(new Error("down"));
    const read = state().loadFirst();
    await vi.runAllTimersAsync();
    await read;
    expect(state()).toMatchObject({ listStatus: "error", total: 0, rows: [] });
  });
});

describe("the reason filter", () => {
  it("reloads from offset 0 with the reason and clears the notice", async () => {
    useScanIssuesStore.setState({ rows: [issue(1), issue(2)], total: 9, notice: { kind: "failed" } });
    vi.mocked(scanIssuesList).mockResolvedValue(page(2, [5, 6], { in_use: 2, other: 7 }));
    await state().setFilter("in_use");
    expect(scanIssuesList).toHaveBeenCalledWith(0, ISSUES_PAGE_SIZE, "in_use");
    expect(state()).toMatchObject({ filter: "in_use", total: 2, notice: null });
    expect(state().rows.map((r) => r.id)).toEqual([5, 6]);
  });

  it("falls back to every reason when the filtered reason has no rows left", async () => {
    vi.mocked(scanIssuesList)
      .mockResolvedValueOnce(page(0, [], { other: 3 }))
      .mockResolvedValueOnce(page(3, [1, 2, 3], { other: 3 }));
    await state().setFilter("in_use");
    expect(scanIssuesList).toHaveBeenLastCalledWith(0, ISSUES_PAGE_SIZE, null);
    expect(state()).toMatchObject({ filter: null, total: 3 });
  });

  it("keeps only a reason that still has rows", () => {
    expect(liveFilter("in_use", { in_use: 1 })).toBe("in_use");
    expect(liveFilter("in_use", { other: 1 })).toBeNull();
    expect(liveFilter(null, { other: 1 })).toBeNull();
  });
});

describe("retry", () => {
  const held = () => useScanIssuesStore.setState({ rows: [issue(1), issue(2)], total: 2, filter: "in_use" });

  it("retries one row by id and refreshes the list and the count", async () => {
    held();
    vi.mocked(scanIssuesRetry).mockResolvedValue({ retried: 1, cleared: 1, remaining: 1 });
    vi.mocked(scanIssuesList).mockResolvedValue(page(1, [2], { in_use: 1 }));
    vi.mocked(scanIssuesCount).mockResolvedValue(1);
    await state().retryOne(1);
    expect(scanIssuesRetry).toHaveBeenCalledWith([1], null);
    expect(state().rows.map((r) => r.id)).toEqual([2]);
    expect(state().count).toBe(1);
    expect(state().notice).toEqual({ kind: "result", cleared: 1, stillFailing: 0 });
  });

  it("retries everything the filter shows by reason", async () => {
    held();
    vi.mocked(scanIssuesRetry).mockResolvedValue({ retried: 2, cleared: 1, remaining: 5 });
    vi.mocked(scanIssuesList).mockResolvedValue(page(1, [2], { in_use: 1, other: 4 }));
    vi.mocked(scanIssuesCount).mockResolvedValue(5);
    await state().retryShown();
    expect(scanIssuesRetry).toHaveBeenCalledWith(null, "in_use");
    expect(state().notice).toEqual({ kind: "result", cleared: 1, stillFailing: 1 });
    expect(state().count).toBe(5);
  });

  it("says so when nothing could be retried because the folder is unavailable", async () => {
    held();
    vi.mocked(scanIssuesRetry).mockResolvedValue({ retried: 0, cleared: 0, remaining: 2 });
    vi.mocked(scanIssuesList).mockResolvedValue(page(2, [1, 2], { in_use: 2 }));
    vi.mocked(scanIssuesCount).mockResolvedValue(2);
    await state().retryShown();
    expect(state().notice).toEqual({ kind: "unavailable" });
  });

  it("surfaces a refusal during a scan and leaves the rows alone", async () => {
    held();
    vi.mocked(scanIssuesRetry).mockRejectedValue("a scan is already running");
    await state().retryShown();
    expect(state().notice).toEqual({ kind: "scanRunning" });
    expect(state().rows).toHaveLength(2);
    expect(scanIssuesList).not.toHaveBeenCalled();
  });

  it("reports any other failure as a failure, rows intact", async () => {
    held();
    vi.mocked(scanIssuesRetry).mockRejectedValue(new Error("boom"));
    await state().retryOne(1);
    expect(state().notice).toEqual({ kind: "failed" });
    expect(state().rows).toHaveLength(2);
  });

  it("words a refusal during a file write apart from a scan", async () => {
    held();
    vi.mocked(scanIssuesRetry).mockRejectedValue("a file write is running");
    await state().retryShown();
    expect(state().notice).toEqual({ kind: "fileWriteRunning" });
    expect(state().rows).toHaveLength(2);
  });

  it("recognises the refusal as a string or an error", () => {
    expect(isScanRunning("a scan is already running")).toBe(true);
    expect(isScanRunning(new Error("a scan is already running"))).toBe(true);
    expect(isScanRunning("index is unavailable")).toBe(false);
    expect(isScanRunning(undefined)).toBe(false);
  });

  it("ignores a second retry while one runs", async () => {
    held();
    let finish: (v: { retried: number; cleared: number; remaining: number }) => void = () => {};
    vi.mocked(scanIssuesRetry).mockReturnValue(new Promise((r) => (finish = r)));
    vi.mocked(scanIssuesList).mockResolvedValue(page(2, [1, 2], { in_use: 2 }));
    vi.mocked(scanIssuesCount).mockResolvedValue(2);
    const first = state().retryShown();
    expect(state().notice).toEqual({ kind: "retrying", n: 2 });
    await state().retryOne(1);
    expect(scanIssuesRetry).toHaveBeenCalledTimes(1);
    finish({ retried: 2, cleared: 0, remaining: 2 });
    await first;
    expect(state().notice).toEqual({ kind: "result", cleared: 0, stillFailing: 2 });
  });
});

describe("retry progress", () => {
  const startRetry = () => {
    useScanIssuesStore.setState({ rows: [issue(1), issue(2)], total: 2 });
    let finish: (v: { retried: number; cleared: number; remaining: number }) => void = () => {};
    vi.mocked(scanIssuesRetry).mockReturnValue(new Promise((r) => (finish = r)));
    vi.mocked(scanIssuesList).mockResolvedValue(page(2, [1, 2], { in_use: 2 }));
    vi.mocked(scanIssuesCount).mockResolvedValue(2);
    const run = state().retryShown();
    return { run, finish };
  };

  it("folds ticks into the running notice", async () => {
    const { run, finish } = startRetry();
    state().applyRetryProgress({ done: 0, total: 2 });
    expect(state().notice).toEqual({ kind: "retrying", n: 2, progress: { done: 0, total: 2 } });
    state().applyRetryProgress({ done: 1, total: 2 });
    expect(state().notice).toMatchObject({ progress: { done: 1, total: 2 } });
    finish({ retried: 2, cleared: 0, remaining: 2 });
    await run;
  });

  it("ignores a tick when no retry runs", () => {
    state().applyRetryProgress({ done: 1, total: 2 });
    expect(state().notice).toBeNull();
    useScanIssuesStore.setState({ notice: { kind: "failed" } });
    state().applyRetryProgress({ done: 1, total: 2 });
    expect(state().notice).toEqual({ kind: "failed" });
  });

  it("ignores a tick that arrives after the reply", async () => {
    const { run, finish } = startRetry();
    state().applyRetryProgress({ done: 1, total: 2 });
    finish({ retried: 2, cleared: 1, remaining: 1 });
    await run;
    state().applyRetryProgress({ done: 2, total: 2 });
    expect(state().notice).toEqual({ kind: "result", cleared: 1, stillFailing: 1 });
  });

  it("drops a done lower than the current one", async () => {
    const { run, finish } = startRetry();
    state().applyRetryProgress({ done: 5, total: 12 });
    state().applyRetryProgress({ done: 3, total: 12 });
    expect(state().notice).toMatchObject({ progress: { done: 5, total: 12 } });
    finish({ retried: 2, cleared: 0, remaining: 2 });
    await run;
  });
});

describe("dismiss", () => {
  it("drops one row at once, then refreshes the list and the count", async () => {
    useScanIssuesStore.setState({ rows: [issue(1), issue(2)], total: 2 });
    vi.mocked(scanIssuesClear).mockResolvedValue(1);
    vi.mocked(scanIssuesList).mockResolvedValue(page(1, [2], { other: 1 }));
    vi.mocked(scanIssuesCount).mockResolvedValue(1);
    await state().dismissOne(1);
    expect(scanIssuesClear).toHaveBeenCalledWith([1], null);
    expect(state().rows.map((r) => r.id)).toEqual([2]);
    expect(state()).toMatchObject({ total: 1, count: 1 });
  });

  it("dismisses everything the filter shows by reason", async () => {
    useScanIssuesStore.setState({ rows: [issue(1)], total: 1, filter: "in_use" });
    vi.mocked(scanIssuesClear).mockResolvedValue(1);
    vi.mocked(scanIssuesList).mockResolvedValue(page(0, [], { other: 4 }));
    vi.mocked(scanIssuesCount).mockResolvedValue(4);
    await state().dismissShown();
    expect(scanIssuesClear).toHaveBeenCalledWith(null, "in_use");
    expect(state()).toMatchObject({ filter: null, count: 4 });
  });

  it("brings a row back when its dismiss fails", async () => {
    useScanIssuesStore.setState({ rows: [issue(1), issue(2)], total: 2 });
    vi.mocked(scanIssuesClear).mockRejectedValue(new Error("boom"));
    vi.mocked(scanIssuesList).mockResolvedValue(page(2, [1, 2], { other: 2 }));
    await state().dismissOne(1);
    expect(state().rows.map((r) => r.id)).toEqual([1, 2]);
    expect(state()).toMatchObject({ total: 2, notice: { kind: "failed" } });
  });

  it("flags a failed dismiss", async () => {
    useScanIssuesStore.setState({ rows: [issue(1)], total: 1 });
    vi.mocked(scanIssuesClear).mockRejectedValue(new Error("boom"));
    await state().dismissShown();
    expect(state().notice).toEqual({ kind: "failed" });
  });
});

describe("copy text and the log", () => {
  it("reads the text for the active filter", async () => {
    useScanIssuesStore.setState({ filter: "disk_error" });
    vi.mocked(scanIssuesText).mockResolvedValue("Plisto scan issues: 1\n");
    expect(await state().readCopyText()).toBe("Plisto scan issues: 1\n");
    expect(scanIssuesText).toHaveBeenCalledWith("disk_error");
  });

  it("returns null and flags a failure when the text cannot be read", async () => {
    vi.mocked(scanIssuesText).mockRejectedValue(new Error("boom"));
    expect(await state().readCopyText()).toBeNull();
    expect(state().notice).toEqual({ kind: "failed" });
  });

  it("says so when there is no log file yet", async () => {
    vi.mocked(scanIssuesOpenLog).mockResolvedValue(false);
    await state().openLog();
    expect(state().notice).toEqual({ kind: "noLog" });
  });

  it("raises no notice when the log opens", async () => {
    vi.mocked(scanIssuesOpenLog).mockResolvedValue(true);
    await state().openLog();
    expect(state().notice).toBeNull();
  });
});

describe("a fresh start after close, and standing refresh", () => {
  it("closing clears the rows, counts and status so a reopen reads again", () => {
    useScanIssuesStore.setState({
      open: true,
      rows: [issue(1)],
      total: 1,
      byReason: { in_use: 1 },
      listStatus: "ready",
    });
    state().closeSheet();
    expect(state()).toMatchObject({ rows: [], total: 0, byReason: {}, listStatus: "idle", filter: null });
  });

  it("a failed list read keeps the rows but reports the error", async () => {
    useScanIssuesStore.setState({ rows: [issue(1)], total: 1, listStatus: "ready" });
    vi.mocked(scanIssuesList).mockRejectedValue(new Error("down"));
    const read = state().loadFirst();
    await vi.runAllTimersAsync();
    await read;
    expect(state().listStatus).toBe("error");
  });

  it("refreshStanding re-reads the count, and the list only while the sheet is open", async () => {
    vi.mocked(scanIssuesCount).mockResolvedValue(3);
    vi.mocked(scanIssuesList).mockResolvedValue(page(1, [1], { other: 1 }));
    await state().refreshStanding();
    expect(state().count).toBe(3);
    expect(scanIssuesList).not.toHaveBeenCalled();
    useScanIssuesStore.setState({ open: true });
    await state().refreshStanding();
    expect(scanIssuesList).toHaveBeenCalled();
  });
});
