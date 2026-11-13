// -- Test Imports --
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

// -- Unit Imports --
import { ScanIssuesRow, issuesRowState } from "./ScanIssuesRow";

// -- i18n Imports --
import { en } from "../../i18n/en";

const noop = () => {};
const row = (count: number | null, status: Parameters<typeof issuesRowState>[1]) =>
  renderToStaticMarkup(<ScanIssuesRow count={count} status={status} onReview={noop} onRetry={noop} />);

describe("issuesRowState", () => {
  it("hides for a real zero and for the first read in flight", () => {
    expect(issuesRowState(0, "ready")).toBe("hidden");
    expect(issuesRowState(null, "loading")).toBe("hidden");
    expect(issuesRowState(null, "idle")).toBe("hidden");
  });

  it("shows above zero and on any failed read", () => {
    expect(issuesRowState(4, "ready")).toBe("count");
    expect(issuesRowState(null, "error")).toBe("error");
    expect(issuesRowState(4, "error")).toBe("error");
  });
});

describe("ScanIssuesRow", () => {
  it("renders nothing at zero", () => {
    expect(row(0, "ready")).toBe("");
  });

  it("shows the count and Review", () => {
    const html = row(1234, "ready");
    expect(html).toContain(en.scan.issuesTitle);
    expect(html).toContain("1,234");
    expect(html).toContain(en.scan.issueReview);
  });

  it("shows a could-not-check line with Retry on a failed read, and no count", () => {
    const html = row(null, "error");
    expect(html).toContain(en.scan.issueCountError);
    expect(html).toContain(en.scan.issueRetry);
    expect(html).not.toContain(en.scan.issueReview);
  });
});
