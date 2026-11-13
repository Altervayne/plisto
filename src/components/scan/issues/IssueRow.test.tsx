// -- Test Imports --
import { describe, expect, it, vi } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

// -- Unit Imports --
import { IssueRow } from "./IssueRow";

// -- Type Imports --
import type { ScanIssue } from "../../../types";

// -- i18n Imports --
import { en } from "../../../i18n/en";

vi.mock("../../../lib/opener", () => ({ openFolder: vi.fn(), revealFile: vi.fn() }));

const issue: ScanIssue = {
  id: 7,
  path: "D:\\Music\\Rips\\03 - Exit.flac",
  root_id: 1,
  track_id: 7,
  kind: "tags",
  reason: "access_denied",
  detail: "<b>denied</b>",
  first_seen: 1_700_000_000,
  last_seen: 1_700_000_000,
};

const render = (over: Partial<ScanIssue> = {}, open = false) =>
  renderToStaticMarkup(
    <IssueRow
      issue={{ ...issue, ...over }}
      open={open}
      busy={false}
      onToggle={() => {}}
      onRetry={() => {}}
      onDismiss={() => {}}
    />,
  );

describe("IssueRow", () => {
  it("shows a file as its name over its folder with the reason and the actions", () => {
    const html = render();
    expect(html).toContain("03 - Exit.flac");
    expect(html).toContain("D:\\Music\\Rips");
    expect(html).toContain(en.scan.issueReasonAccessDenied);
    expect(html).toContain(`aria-label="${en.scan.issueReveal}"`);
    expect(html).toContain(`aria-label="${en.scan.issueDismissTip}"`);
    expect(html).not.toContain(en.scan.issueKindFolder);
    expect(html).not.toContain("permissions.");
  });

  it("tags a folder and offers Open folder", () => {
    const html = render({ kind: "folder", path: "D:\\Music\\Private" });
    expect(html).toContain(en.scan.issueKindFolder);
    expect(html).toContain(`aria-label="${en.scan.issueOpenFolder}"`);
  });

  it("shortens a long folder path in the row but keeps it whole when opened", () => {
    const path = `D:\\Music\\${"Archives\\".repeat(14)}Last\\song.flac`;
    expect(render({ path })).toContain("...");
    expect(render({ path }, true)).toContain(path);
  });

  it("opens to the hint, the raw detail as escaped text, and a Retry", () => {
    const html = render({}, true);
    expect(html).toContain("permissions.");
    expect(html).toContain("&lt;b&gt;denied&lt;/b&gt;");
    expect(html).not.toContain("<b>denied</b>");
    expect(html).toContain(`aria-label="${en.scan.issueRetry}"`);
  });
});
