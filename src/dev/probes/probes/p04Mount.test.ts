// -- Test Imports --
import { describe, expect, it } from "vitest";

// -- Unit Imports --
import { p4Verdict, randomSalt, saltPrograms, saltSource } from "./p04Mount";

// -- Local Imports --
import { LAKE_PROGRAMS } from "../../../components/player/visualizers/gl/lake";
import { SHARED_PROGRAMS } from "../../../components/player/visualizers/gl/shaders";

describe("salt", () => {
  it("differs between two runs and keeps the #version line first", () => {
    const a = randomSalt();
    const b = randomSalt();
    expect(a).not.toBe(b);
    for (const p of [...LAKE_PROGRAMS, ...SHARED_PROGRAMS]) {
      const salted = saltPrograms([p], a)[0];
      const other = saltPrograms([p], b)[0];
      expect(salted.fs.split("\n")[0]).toMatch(/^#version/);
      expect(salted.vs.split("\n")[0]).toMatch(/^#version/);
      expect(salted.fs.split("\n")[1]).toBe(`// run ${a}`);
      expect(salted.fs).not.toBe(other.fs);
      expect(salted.fs.replace(`// run ${a}\n`, "")).toBe(p.fs);
    }
  });

  it("refuses a source with no leading #version line", () => {
    expect(() => saltSource("void main() {}", "x")).toThrow();
  });
});

describe("p4Verdict", () => {
  const ok = { coldMs: 800, warmMs: 200, coldWasCold: true, frameSeen: true, linkFailures: 0 };

  it("passes under the warm and cold lines", () => {
    expect(p4Verdict(ok).state).toBe("pass");
  });

  it("fails over either line", () => {
    expect(p4Verdict({ ...ok, warmMs: 400 }).state).toBe("fail");
    expect(p4Verdict({ ...ok, coldMs: 1200 }).state).toBe("fail");
  });

  it("is invalid for a link failure or a cold run that was not cold", () => {
    expect(p4Verdict({ ...ok, linkFailures: 1 }).state).toBe("invalid");
    expect(p4Verdict({ ...ok, coldWasCold: false }).state).toBe("invalid");
  });

  it("is invalid, never pass or fail, when the process list never showed the frame", () => {
    const v = p4Verdict({ ...ok, frameSeen: false, coldMs: 5000 });
    expect(v.state).toBe("invalid");
    expect(v.reasons.join(" ")).toContain("does not show the frame");
  });
});
