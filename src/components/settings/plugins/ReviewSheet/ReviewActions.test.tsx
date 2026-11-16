// -- Test Imports --
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

// -- Unit Imports --
import { ReviewActions } from "./ReviewActions";
import { inspection, row } from "../../../../state/plugins/fixtures";
import { subjectFromInspection, subjectFromRow } from "../../../../state/plugins/review";

// -- i18n Imports --
import { en } from "../../../../i18n/en";

// -- Type Imports --
import type { ReviewMode, ReviewSubject } from "../../../../state/plugins/review";

const render = (subject: ReviewSubject, mode: ReviewMode) =>
  renderToStaticMarkup(<ReviewActions subject={subject} mode={mode} onConfirm={() => {}} onCancel={() => {}} />);

const note = en.plugins.sheet.leftoverNote;
const tick = en.plugins.sheet.leftoverClear;

describe("the leftover saved data note and tick", () => {
  it("appear for an install over leftover data, with the tick off", () => {
    const html = render(subjectFromInspection(inspection({ leftover_data: true })), "install");
    expect(html).toContain(note);
    expect(html).toContain(tick);
    expect(html).not.toContain("aria-checked=\"true\"");
  });

  it("do not appear for an install without leftover data", () => {
    const html = render(subjectFromInspection(inspection()), "install");
    expect(html).not.toContain(note);
    expect(html).not.toContain(tick);
  });

  it("never appear for an update or a review of an installed row", () => {
    const update = subjectFromInspection(inspection({ leftover_data: true, installed: "1.3.0" }), row());
    expect(render(update, "update")).not.toContain(note);
    const installed = subjectFromRow(row())!;
    expect(render({ ...installed, leftoverData: true }, "consent")).not.toContain(note);
  });
});
