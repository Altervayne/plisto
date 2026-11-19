// -- Test Imports --
import { describe, expect, it } from "vitest";

// The specifier is held in a variable so the import stays untyped whether or not node typings are in the program.
const fsModule = "node:fs";
const { readdirSync, readFileSync } = (await import(/* @vite-ignore */ fsModule)) as {
  readdirSync: (url: URL, opts: { withFileTypes: true }) => { name: string; isDirectory(): boolean }[];
  readFileSync: (url: URL, enc: string) => string;
};

// An iframe's title is its accessible name, not a hover tooltip.
const ALLOWED = new Set(["iframe"]);

/** The lowercase element names that carry a `title` attribute in a source's JSX, in order. */
function nativeTitleTags(source: string): string[] {
  // An opening tag: a lowercase name, then attributes, where a `{...}` value may hold nested braces and `>`.
  const tag = /<([a-z][\w-]*)((?:[^<>{}]|\{(?:[^{}]|\{(?:[^{}]|\{[^{}]*\})*\})*\})*)>/g;
  const found: string[] = [];
  for (const match of source.matchAll(tag)) {
    if (/(^|\s)title\s*=/.test(match[2]) && !ALLOWED.has(match[1])) found.push(match[1]);
  }
  return found;
}

/** Every non-test .tsx file under a directory, as URLs. */
function sources(dir: URL): URL[] {
  const out: URL[] = [];
  for (const entry of readdirSync(dir, { withFileTypes: true })) {
    if (entry.isDirectory()) out.push(...sources(new URL(`${entry.name}/`, dir)));
    else if (entry.name.endsWith(".tsx") && !entry.name.endsWith(".test.tsx")) out.push(new URL(entry.name, dir));
  }
  return out;
}

describe("native tooltips", () => {
  it("are found on a plain element, in any attribute position", () => {
    expect(nativeTitleTags('<span className={styles.name} title={name}>x</span>')).toEqual(["span"]);
    expect(nativeTitleTags('<button\n  type="button"\n  title={t((d) => d.a.b)}\n>')).toEqual(["button"]);
    expect(nativeTitleTags('<div title="note" onClick={() => go()}>')).toEqual(["div"]);
  });

  it("are not found on components, other props, or an iframe", () => {
    expect(nativeTitleTags('<EmptyState title={a} line="" />')).toEqual([]);
    expect(nativeTitleTags('<b data-title="">{p.title ?? ""}</b>')).toEqual([]);
    expect(nativeTitleTags('<iframe title={t((d) => d.plugins.frame.title)} />')).toEqual([]);
  });

  it("are absent from the app's source", () => {
    const offenders = sources(new URL("../../../", import.meta.url)).flatMap((url) =>
      nativeTitleTags(readFileSync(url, "utf8")).map((name) => `${url.pathname.split("/src/")[1]}: <${name}>`),
    );
    // Use the Tooltip, or TruncatedText for a clipped name: the system tooltip is off-brand.
    expect(offenders).toEqual([]);
  });
});
