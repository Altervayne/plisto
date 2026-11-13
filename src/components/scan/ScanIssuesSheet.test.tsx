// -- Test Imports --
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

// -- Unit Imports --
import { ScanIssuesSheet } from "./ScanIssuesSheet";

// -- State Imports --
import type { IssueNotice } from "../../state/scanIssues";

// -- Type Imports --
import type { ScanIssue, ScanIssueReason } from "../../types";

// -- i18n Imports --
import { en } from "../../i18n/en";

// The static renderer has no portal target, so the sheet renders in place.
vi.mock("react-dom", () => ({ createPortal: (node: unknown) => node }));
vi.mock("../../lib/ipc", () => ({
  scanIssuesCount: vi.fn(),
  scanIssuesList: vi.fn(),
  scanIssuesRetry: vi.fn(),
  scanIssuesClear: vi.fn(),
  scanIssuesText: vi.fn(),
  scanIssuesOpenLog: vi.fn(),
}));
// The server renderer reads a zustand store's initial snapshot, so the sheet reads a plain stand-in.
const fake = vi.hoisted(() => ({ state: {} as Record<string, unknown> }));
vi.mock("../../state/scanIssues", () => ({
  ISSUES_PAGE_SIZE: 200,
  useScanIssuesStore: Object.assign(
    (select: (state: Record<string, unknown>) => unknown) => select(fake.state),
    { getState: () => ({ ...fake.state, clearNotice: () => {} }) },
  ),
}));
vi.mock("../../lib/opener", () => ({ openFolder: vi.fn(), revealFile: vi.fn() }));

const issue = (id: number, reason: ScanIssueReason = "access_denied"): ScanIssue => ({
  id,
  path: `D:\\Music\\Rips\\${id} - track.flac`,
  root_id: 1,
  track_id: id,
  kind: "tags",
  reason,
  detail: "denied",
  first_seen: 1_700_000_000,
  last_seen: 1_700_000_000,
});

const render = () => renderToStaticMarkup(<ScanIssuesSheet onClose={() => {}} />);
const seed = (patch: Record<string, unknown>) => {
  fake.state = { rows: [], total: 0, byReason: {}, filter: null, listStatus: "idle", notice: null, ...patch };
};

beforeEach(() => {
  vi.stubGlobal("document", { body: {} });
  seed({});
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("ScanIssuesSheet", () => {
  it("lists the rows with a chip per reason and the bar", () => {
    seed({
      rows: [issue(1), issue(2, "in_use")],
      total: 2,
      byReason: { access_denied: 1, in_use: 1 },
      listStatus: "ready",
    });
    const html = render();
    expect(html).toContain(en.scan.issuesTitle);
    expect(html).toContain("1 - track.flac");
    expect(html).toContain(en.scan.issueAll);
    expect(html).toContain(en.scan.issueReasonInUse);
    expect(html).toContain("The log holds one line");
  });

  it("hides the chips when one reason is left", () => {
    seed({ rows: [issue(1)], total: 1, byReason: { access_denied: 1 }, filter: "access_denied", listStatus: "ready" });
    expect(render()).not.toContain(`>${en.scan.issueAll}<`);
  });

  it("says how many of the standing rows are loaded", () => {
    seed({ rows: [issue(1)], total: 5, byReason: { access_denied: 5 }, listStatus: "ready" });
    const html = render();
    expect(html).toContain("Showing 1 of 5");
    expect(html).toContain("Show 4 more");
  });

  it.each<[string, IssueNotice, string]>([
    ["retrying", { kind: "retrying", n: 3 }, "Retrying 3 files..."],
    ["a clean result", { kind: "result", cleared: 2, stillFailing: 0 }, "2 fixed"],
    ["a partial result", { kind: "result", cleared: 2, stillFailing: 1 }, "1 still unreadable"],
    ["scan running", { kind: "scanRunning" }, en.scan.issueScanRunning],
    ["no log", { kind: "noLog" }, en.scan.issueNoLog],
    ["unavailable", { kind: "unavailable" }, en.scan.issueRetryUnavailable],
    ["failed", { kind: "failed" }, en.scan.issueActionFailed],
  ])("shows the %s notice", (_name, notice, text) => {
    seed({ rows: [issue(1)], total: 1, byReason: { access_denied: 1 }, listStatus: "ready", notice });
    expect(render()).toContain(text);
  });

  it("shows the empty state", () => {
    seed({ listStatus: "ready" });
    const html = render();
    expect(html).toContain(en.scan.issueEmptyTitle);
    expect(html).not.toContain("The log holds one line");
  });

  it("shows a still skeleton while the first read runs", () => {
    seed({ listStatus: "loading" });
    const html = render();
    expect(html).toContain(en.scan.issueLoading);
    expect(html).toContain('aria-busy="true"');
  });

  it("shows the load error with Retry when no rows are held", () => {
    seed({ listStatus: "error" });
    const html = render();
    expect(html).toContain(en.scan.issueLoadErrorBody);
    expect(html).toContain(en.scan.issueRetry);
  });

  it("shows an inline error with Retry over rows held through a failed read, in place of the notice", () => {
    seed({
      rows: [issue(1)],
      total: 1,
      byReason: { access_denied: 1 },
      listStatus: "error",
      notice: { kind: "result", cleared: 4, stillFailing: 0 },
    });
    const html = render();
    expect(html).toContain('role="alert"');
    expect(html).toContain(en.scan.issueLoadError);
    expect(html).toContain(en.scan.issueRetry);
    expect(html).not.toContain("4 fixed");
  });
});
