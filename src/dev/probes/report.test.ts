// -- Test Imports --
import { describe, expect, it } from "vitest";

// -- Unit Imports --
import { CATALOG } from "./catalog";
import { buildReport, clean } from "./report";

// -- Type Imports --
import type { CardResult } from "./types";

const header = { version: "2.7.0", webview2: "130.0.1", dpr: 1.25, displayHz: 143.6, gl: "ANGLE (test)", theme: "dark" };

describe("buildReport", () => {
  const results = new Map<string, CardResult>([
    ["P1", { state: "pass", lines: ["32/32 cases within 2/255", "control ok"] }],
    ["P2", { state: "fail", lines: ["opaque"] }],
  ]);
  const text = buildReport(header, CATALOG, results, new Set(["P1", "P2"]));
  const lines = text.split("\n");

  it("is ASCII with LF line endings and no carriage return", () => {
    expect(text).toMatch(/^[\x20-\x7e\n]+$/);
    expect(text.endsWith("\n")).toBe(true);
  });

  it("has a title, a header line, and one line per catalog entry", () => {
    expect(lines[0]).toBe("Plisto visualizer probes");
    expect(lines[1]).toBe('build 2.7.0 dev | webview2 130.0.1 | dpr 1.25 | display 144 Hz | gl "ANGLE (test)" | theme dark');
    expect(lines).toHaveLength(2 + CATALOG.length + 1);
  });

  it("joins a probe's result lines and names its state", () => {
    expect(lines[2]).toMatch(/^P1\s+PASS\s+32\/32 cases within 2\/255; control ok$/);
    expect(lines[3]).toMatch(/^P2\s+FAIL\s+opaque$/);
  });

  it("reads a probe with no module as not built and an out-of-scope probe with its reason", () => {
    expect(lines.find((l) => l.startsWith("P3 "))).toMatch(/NOT BUILT/);
    expect(lines.find((l) => l.startsWith("P13 "))).toMatch(/NOT IN V0\s+Needs the renderer seam/);
  });

  it("states an unmeasured display rate as unknown", () => {
    expect(buildReport({ ...header, displayHz: null }, CATALOG, new Map(), new Set()).split("\n")[1]).toContain(
      "display unknown",
    );
  });
});

describe("clean", () => {
  it("replaces drive and home paths, folds line breaks and masks non-ASCII", () => {
    expect(clean("saved C:\\Users\\someone\\AppData\\x.png ok")).toBe("saved <path> ok");
    expect(clean("at /Users/someone/file.png")).toBe("at <path>");
    expect(clean("a\r\nb")).toBe("a b");
    expect(clean("caf\u00e9")).toBe("caf?");
  });

  it("leaves a URL alone and still scrubs drive paths with either slash", () => {
    expect(clean("host https://probe-vis.invalid")).toBe("host https://probe-vis.invalid");
    expect(clean("file C:\\Users\\x\\file here")).toBe("file <path> here");
    expect(clean("file C:/Users/x here")).toBe("file <path> here");
  });
});
