// -- Test Imports --
import { describe, expect, it } from "vitest";

// The test runner blanks a CSS import (even ?raw), so the file is read directly. The specifier is held in
// a variable so the import stays untyped whether or not node typings are in the program.
const fsModule = "node:fs";
const { readFileSync } = (await import(/* @vite-ignore */ fsModule)) as {
  readFileSync: (url: URL, enc: string) => string;
};

const css = readFileSync(new URL("./tokens.css", import.meta.url), "utf8").replace(/\/\*[\s\S]*?\*\//g, "");

/** The body of the first rule whose selector is exactly `selector`, braces matched. */
function ruleBody(selector: string): string {
  const at = css.indexOf(`${selector} {`);
  if (at < 0) throw new Error(`no rule for ${selector}`);
  let depth = 0;
  const open = css.indexOf("{", at);
  for (let i = open; i < css.length; i++) {
    if (css[i] === "{") depth++;
    else if (css[i] === "}" && --depth === 0) return css.slice(open + 1, i);
  }
  throw new Error(`unclosed rule for ${selector}`);
}

/** The declarations of a rule body as property -> value, whitespace collapsed. */
function declarations(body: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of body.split(";")) {
    const colon = part.indexOf(":");
    if (colon < 0) continue;
    out[part.slice(0, colon).trim()] = part.slice(colon + 1).replace(/\s+/g, " ").trim();
  }
  return out;
}

describe("the dark tokens", () => {
  const media = declarations(ruleBody(':root:not([data-theme="light"])'));
  const explicit = declarations(ruleBody('[data-theme="dark"]'));

  it("are identical in the system block and the explicit block", () => {
    expect(Object.keys(media).length).toBeGreaterThan(30);
    expect(explicit).toEqual(media);
  });

  it("match any element, so a stamped subtree re-roots them", () => {
    expect(css).not.toContain(':root[data-theme="dark"]');
  });

  it("give an island its own ink and scheme, and leave the root alone", () => {
    const island = declarations(ruleBody(':not(:root)[data-theme="dark"]'));
    expect(island).toEqual({ color: "var(--ink)", "color-scheme": "dark" });
  });
});
