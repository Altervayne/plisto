// -- Test Imports --
import { describe, expect, it } from "vitest";

// -- Framework Imports --
import { createElement } from "react";
import { renderToStaticMarkup } from "react-dom/server";

// -- Component Imports --
import { NavItem } from "./NavItem";

const html = (extra: Partial<Parameters<typeof NavItem>[0]> = {}) =>
  renderToStaticMarkup(createElement(NavItem, { icon: createElement("i"), label: "Home", active: false, onClick: () => {}, ...extra }));

describe("NavItem", () => {
  it("renders icon, label and nothing else without chips", () => {
    expect(html()).toMatch(/^<button type="button" class="[^"]*"><i><\/i><span class="[^"]*">Home<\/span><\/button>$/);
  });

  it("keeps the count path as it was", () => {
    expect(html({ count: 1200 })).toMatch(/<span class="[^"]*">Home<\/span><span class="[^"]*">[^<]+<\/span><\/button>$/);
  });

  it("adds the chips slot after the label when given", () => {
    const withChips = html({ chips: createElement("b", null, "3") });
    expect(withChips).toContain("<b>3</b>");
    expect(withChips.indexOf("Home")).toBeLessThan(withChips.indexOf("<b>"));
    expect(withChips).not.toBe(html());
  });
});
