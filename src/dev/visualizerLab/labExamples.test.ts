// -- Test Imports --
import { describe, expect, it } from "vitest";

// -- Unit Imports --
import { compositeOf, exampleKind, joinPath, pageScripts, parseDecls, settingDefaults } from "./labExamples";
// @ts-expect-error the looks tool is a plain script without declarations
import { exampleSha, filesSha, isExampleKind } from "../../../tools/vis-looks.mjs";

describe("exampleKind", () => {
  it("names a kind under its folder, so it never meets a fixture kind", () => {
    expect(exampleKind("lake", "lake")).toBe("lake/lake");
    expect(isExampleKind("lake/lake")).toBe(true);
    expect(isExampleKind("lake")).toBe(false);
  });
});

describe("pageScripts", () => {
  it("lists the scripts in order and skips the runtime's", () => {
    const html = `<script src="/_plisto/vis/1/plisto-vis.js"></script>
<script type="module" src="orbs.js"></script><script src="a.js"></script><script>go()</script>`;
    expect(pageScripts(html)).toEqual([
      { src: "orbs.js", text: "", module: true },
      { src: "a.js", text: "", module: false },
      { src: null, text: "go()", module: false },
    ]);
  });
});

describe("joinPath", () => {
  it("resolves a script against its page's folder", () => {
    expect(joinPath("vis", "tunnel.js")).toBe("vis/tunnel.js");
    expect(joinPath("vis", "./vendor/x.js")).toBe("vis/vendor/x.js");
    expect(joinPath("vis/sub", "../x.js")).toBe("vis/x.js");
    expect(joinPath("", "x.js")).toBe("x.js");
  });
});

describe("manifest facts", () => {
  it("reads a kind's page or shader, flags and settings", () => {
    const [d] = parseDecls(
      JSON.stringify({
        visualizers: [
          { id: "k", shader: "vis/k.frag", look: "glow", fills_stage: true, needs: { cover: true } },
        ],
      }),
    );
    expect(d).toMatchObject({ id: "k", shader: "vis/k.frag", page: null, fillsStage: true, darkOnly: false });
    expect(d.needs).toEqual({ fine: false, cover: true, pointer: false, waveform: false });
  });

  it("maps a look to its composite per theme", () => {
    expect(compositeOf("glow")).toEqual({ light: "ink", dark: "light" });
    expect(compositeOf("image")).toEqual({ light: "image", dark: "image" });
    expect(compositeOf({ light: { composite: "ink" }, dark: { composite: "image" } })).toEqual({
      light: "ink",
      dark: "image",
    });
    expect(() => compositeOf({})).toThrow();
  });

  it("starts each setting at its default, else the installer's value", () => {
    expect(
      settingDefaults([
        { id: "a", type: "choice", default: "fast", options: [{ id: "calm" }, { id: "fast" }] },
        { id: "b", type: "choice", options: [{ id: "calm" }] },
        { id: "c", type: "toggle" },
        { id: "d", type: "range", min: 0.5 },
        { id: "e", type: "color" },
      ]),
    ).toEqual({ a: "fast", b: "calm", c: false, d: 0.5, e: "cover" });
  });
});

describe("filesSha", () => {
  it("ignores the order and the line endings of the files", () => {
    expect(filesSha([["b", "x\r\ny"], ["a", "z"]])).toBe(filesSha([["a", "z"], ["b", "x\ny"]]));
  });

  it("changes with a file's content, a name or an added file", () => {
    const base = filesSha([["a", "1"]]);
    expect(filesSha([["a", "2"]])).not.toBe(base);
    expect(filesSha([["b", "1"]])).not.toBe(base);
    expect(filesSha([["a", "1"], ["b", ""]])).not.toBe(base);
  });

  it("keeps a file's end and the next file's start apart", () => {
    expect(filesSha([["a", "x"], ["b", "y"]])).not.toBe(filesSha([["a", "xb"], ["", "y"]]));
  });
});

describe("exampleSha", () => {
  it("covers a mixed example's vis folder, not its page files", () => {
    expect(exampleSha("band-tunnel-mixed/band-tunnel-mixed")).toMatch(/^[0-9a-f]{64}$/);
  });
});
