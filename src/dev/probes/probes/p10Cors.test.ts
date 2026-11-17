// -- Test Imports --
import { describe, expect, it } from "vitest";

// -- Unit Imports --
import { judgeCors, newLines } from "./p10Cors";
import type { HostRow, TryState } from "./p10Cors";

function row(host: string, expectOk: boolean, state: TryState | null): HostRow {
  return {
    host,
    expectOk,
    tries: state === null ? null : ["fetch", "module", "image upload"].map((name) => ({ name, state })),
  };
}

const good = [row("probe-ui0", false, "fail"), row("probe-ui0s", false, "fail"), row("probe-ui1", true, "ok")];

describe("judgeCors", () => {
  it("passes when the added-header host succeeds and the others fail", () => {
    expect(judgeCors(good).state).toBe("pass");
  });

  it("fails where a host does the opposite of its expectation", () => {
    const v = judgeCors([row("probe-ui0", false, "fail"), row("probe-ui0s", false, "ok"), row("probe-ui1", true, "ok")]);
    expect(v.state).toBe("fail");
    expect(v.problems).toContain("probe-ui0s fetch succeeded");
  });

  it("is invalid, not a failure, when a frame gave no result", () => {
    const v = judgeCors([good[0], good[1], row("probe-ui1", true, null)]);
    expect(v.state).toBe("invalid");
    expect(v.problems).toEqual(["probe-ui1 gave no result"]);
  });

  it("is invalid when a try could not run, whatever the others say", () => {
    const v = judgeCors([good[0], good[1], row("probe-ui1", true, "unavailable")]);
    expect(v.state).toBe("invalid");
  });

  it("is invalid with no rows", () => {
    expect(judgeCors([]).state).toBe("invalid");
  });
});

describe("newLines", () => {
  it("returns the lines appended", () => {
    expect(newLines(["a", "b"], ["a", "b", "c"])).toEqual(["c"]);
  });

  it("follows a buffer that dropped its oldest lines", () => {
    expect(newLines(["a", "b", "c"], ["b", "c", "d", "e"])).toEqual(["d", "e"]);
  });

  it("returns everything when nothing overlaps, and nothing when nothing changed", () => {
    expect(newLines(["a"], ["x", "y"])).toEqual(["x", "y"]);
    expect(newLines(["a", "b"], ["a", "b"])).toEqual([]);
  });
});
