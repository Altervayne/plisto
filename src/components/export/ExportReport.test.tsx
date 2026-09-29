// -- Test Imports --
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

// -- Unit Imports --
import { ExportReport } from "./ExportReport";

// -- Type Imports --
import type { ExportSummary } from "../../types";

const base: ExportSummary = {
  total: 3,
  exported: 3,
  skipped: 0,
  errors: 0,
  unchanged: 0,
  cancelled: false,
  containers_written: 1,
  items: [],
};

describe("ExportReport", () => {
  it("leaves the unchanged line out when nothing was left alone", () => {
    expect(renderToStaticMarkup(<ExportReport summary={base} />)).not.toContain("unchanged");
  });

  it("counts the files a changed-only run left alone, apart from skips and errors", () => {
    const html = renderToStaticMarkup(<ExportReport summary={{ ...base, unchanged: 117 }} />);
    expect(html).toContain("117 unchanged");
    expect(html).not.toContain("skipped");
    expect(html).not.toContain("error");
  });
});
