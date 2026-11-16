// -- Test Imports --
import { describe, expect, it } from "vitest";

// -- Framework Imports --
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

// -- Component Imports --
import { TruncatedText } from "./TruncatedText";

describe("TruncatedText", () => {
  it("draws the text in a span with the given class and no tooltip until it is measured as cut", () => {
    const html = renderToStaticMarkup(createElement(TruncatedText, { text: "A long plugin name", className: "clip" }));
    expect(html).toBe('<span class="clip">A long plugin name</span>');
  });
});
