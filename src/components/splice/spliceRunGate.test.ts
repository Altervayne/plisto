// -- Framework Imports --
import { describe, expect, it } from "vitest";

// -- Unit Imports --
import { runBlockers } from "./spliceRunGate";

// -- Type Imports --
import type { DestinationCheck } from "../../types";

const OK: DestinationCheck = { ok: true, inside_workspace: false, non_empty: false, writable: true };

describe("runBlockers", () => {
  it("names a missing folder first, ahead of the body gate", () => {
    expect(runBlockers(null, null, false, false)).toEqual(["noDestination", "gate"]);
  });

  it("blocks while the check is in flight, distinct from a failed check", () => {
    expect(runBlockers("D:/out", null, true, true)).toEqual(["checking"]);
  });

  it("flags a folder whose check failed", () => {
    expect(runBlockers("D:/out", null, false, true)).toEqual(["unchecked"]);
  });

  it("lists a refused folder", () => {
    expect(runBlockers("D:/out", { ...OK, ok: false, inside_workspace: true }, false, true)).toEqual([
      "invalidDestination",
    ]);
  });

  it("names the body gate when only nothing is left to run", () => {
    expect(runBlockers("D:/out", OK, false, false)).toEqual(["gate"]);
  });

  it("is empty when ready", () => {
    expect(runBlockers("D:/out", OK, false, true)).toEqual([]);
  });
});
