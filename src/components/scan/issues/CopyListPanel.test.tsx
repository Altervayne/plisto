// -- Test Imports --
import { describe, expect, it } from "vitest";
import { renderToStaticMarkup } from "react-dom/server";

// -- Unit Imports --
import { CopyListView } from "./CopyListPanel";

// -- i18n Imports --
import { en } from "../../../i18n/en";

const text = (n: number) =>
  `Plisto scan issues: ${n}\n${Array.from({ length: n }, (_, i) => `other\tD:\\m\\${i}.mp3\tboom`).join("\n")}\n`;

const view = (body: string | null, copied = false) =>
  renderToStaticMarkup(<CopyListView text={body} copied={copied} onCopy={() => {}} onClose={() => {}} />);

describe("CopyListView", () => {
  it("previews 15 lines and says how many more follow", () => {
    const html = view(text(40));
    expect(html).toContain("D:\\m\\14.mp3");
    expect(html).not.toContain("D:\\m\\15.mp3");
    expect(html).toContain("and 25 more");
  });

  it("has no more line for a short list", () => {
    expect(view(text(3))).not.toContain(" more<");
  });

  it("shows the copied state after a copy", () => {
    expect(view(text(3), true)).toContain(en.scan.issueCopied);
    expect(view(text(3), false)).toContain(en.scan.issueCopyButton);
  });

  it("shows a loading line and a disabled Copy before the text lands", () => {
    const html = view(null);
    expect(html).toContain(en.scan.issueLoading);
    expect(html).toContain("disabled");
  });
});
