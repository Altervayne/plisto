// -- Test Imports --
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

// -- Unit Imports --
import { SheetHeader } from "./SheetHeader";
import { inspection, row } from "../../../../state/plugins/fixtures";
import { subjectFromInspection } from "../../../../state/plugins/review";

// -- i18n Imports --
import { en } from "../../../../i18n/en";

const render = (author: string, previousAuthor: string) => {
  const base = subjectFromInspection(inspection({ installed: "1.3.0", author }), row());
  const subject = { ...base, previous: { ...base.previous!, author: previousAuthor } };
  return renderToStaticMarkup(<SheetHeader subject={subject} icon={{ kind: "staged", token: "t" }} titleId="t" />);
};

const marker = en.plugins.sheet.authorChanged.split("{")[0];

describe("the sheet header's author caution", () => {
  it("names both authors as plain text when they differ", () => {
    const html = render("New <b>Name</b>", "Old Name");
    expect(html).toContain(marker);
    expect(html).toContain("Old Name");
    expect(html).toContain("New &lt;b&gt;Name&lt;/b&gt;");
    expect(html).not.toContain("<b>Name</b>");
  });

  it("is absent when the authors match or the previous author is unknown", () => {
    expect(render("Lyric Works", "Lyric Works")).not.toContain(marker);
    expect(render("Lyric Works", "")).not.toContain(marker);
  });
});
