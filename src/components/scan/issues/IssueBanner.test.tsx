// -- Test Imports --
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

// -- Unit Imports --
import { IssueBanner } from "./IssueBanner";

// -- State Imports --
import type { IssueNotice } from "../../../state/scanIssues";

const render = (notice: IssueNotice) => renderToStaticMarkup(<IssueBanner notice={notice} />);

describe("IssueBanner retrying", () => {
  it("keeps the count line before the first tick", () => {
    expect(render({ kind: "retrying", n: 12 })).toContain("Retrying 12 files...");
  });

  it("keeps the count line for a single file", () => {
    const html = render({ kind: "retrying", n: 1, progress: { done: 0, total: 1 } });
    expect(html).toContain("Retrying 1 file...");
    expect(html).not.toContain(" of ");
  });

  it("shows the progress line once a tick for several files has arrived", () => {
    const html = render({ kind: "retrying", n: 12, progress: { done: 5, total: 12 } });
    expect(html).toContain("Retrying 5 of 12...");
    expect(html).toContain("width:41.66");
  });

  it("clamps the bar to the full width", () => {
    const html = render({ kind: "retrying", n: 4, progress: { done: 9, total: 4 } });
    expect(html).toContain("width:100%");
  });

  it("draws no bar before a tick or for a single file", () => {
    expect(render({ kind: "retrying", n: 12 })).not.toContain("width:");
    expect(render({ kind: "retrying", n: 1, progress: { done: 0, total: 1 } })).not.toContain("width:");
  });
});
