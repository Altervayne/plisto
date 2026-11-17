// -- Test Imports --
import { describe, expect, it } from "vitest";

// -- Unit Imports --
import { judgeP2, type ThemeReadings } from "./p02Transparency";

// -- Type Imports --
import type { DiffStats } from "../pixelDiff";

const ok = (max: number): DiffStats => ({ valid: true, max, over: 0, p999: 0, compared: 100 });

const readings = (over: Partial<ThemeReadings> = {}): ThemeReadings => ({
  empty: ok(0),
  overSubject: ok(0),
  overReference: ok(1),
  solid: ok(150),
  mismatch: ok(200),
  ...over,
});

describe("judgeP2", () => {
  it("passes when an empty frame changes nothing in both themes", () => {
    expect(judgeP2({ light: readings(), dark: readings() }, "capture scale 1.25").state).toBe("pass");
  });

  it("fails when an empty frame paints", () => {
    const out = judgeP2({ light: readings(), dark: readings({ overSubject: ok(212) }) }, "");
    expect(out.state).toBe("fail");
    expect(out.lines[0]).toContain("dark");
  });

  it("is invalid when the opaque control is not visible", () => {
    expect(judgeP2({ light: readings({ solid: ok(3) }), dark: readings() }, "").state).toBe("invalid");
  });

  it("is invalid when the empty stages differ or a reading is unreadable", () => {
    expect(judgeP2({ light: readings({ empty: ok(5) }), dark: readings() }, "").state).toBe("invalid");
    const unreadable: DiffStats = { valid: false, reason: "scale" };
    expect(judgeP2({ light: readings(), dark: readings({ overReference: unreadable }) }, "").state).toBe("invalid");
  });

  it("does not judge the scheme mismatch", () => {
    expect(judgeP2({ light: readings({ mismatch: ok(0) }), dark: readings() }, "").state).toBe("pass");
  });
});
