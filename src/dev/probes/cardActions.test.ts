// -- Test Imports --
import { describe, expect, it } from "vitest";

// -- Unit Imports --
import { applyVerdict, beginAction, canRunAction, finishAction, offerEntries } from "./cardActions";
import { CATALOG } from "./catalog";
import { buildReport } from "./report";

// -- Type Imports --
import type { CardAction, CardResult } from "./types";

const HEADER = { version: "2.7.0", webview2: "1", dpr: 1, displayHz: 60, gl: "gl", theme: "dark" };

function reportOf(card: CardResult): string {
  return buildReport(HEADER, CATALOG, new Map([["P1", card]]), new Set(["P1"]));
}

describe("applyVerdict", () => {
  it("demotes a pass to invalid in the card and in the report text", () => {
    const card = applyVerdict({ state: "pass", lines: ["32/32"] }, { state: "invalid", line: "screenshot disagrees" });
    expect(card).toEqual({ state: "invalid", lines: ["32/32", "screenshot disagrees"] });
    expect(reportOf(card)).toMatch(/^P1\s+INVALID\s+32\/32; screenshot disagrees$/m);
  });

  it("never upgrades: a fail stays a fail when the action returns pass", () => {
    const card = applyVerdict({ state: "fail", lines: ["3 cases"] }, { state: "pass", line: "looks fine" });
    expect(card.state).toBe("fail");
    expect(card.lines).toEqual(["3 cases", "looks fine"]);
    expect(reportOf(card)).toMatch(/^P1\s+FAIL\s/m);
  });

  it("does not soften an invalid to a fail, and ignores other states", () => {
    expect(applyVerdict({ state: "invalid", lines: [] }, { state: "fail" }).state).toBe("invalid");
    expect(applyVerdict({ state: "pass", lines: [] }, { state: "measured" }).state).toBe("pass");
    expect(applyVerdict({ state: "pass", lines: [] }, { state: "fail" }).state).toBe("fail");
  });
});

const action = (id: string): CardAction => ({ id, label: id, run: async () => {} });

describe("card actions", () => {
  it("offers every action ready, dropping a repeated id", () => {
    const entries = offerEntries([action("a"), action("b"), action("a")], []);
    expect(entries.map((e) => [e.action.id, e.status])).toEqual([
      ["a", "ready"],
      ["b", "ready"],
    ]);
  });

  it("runs an action once: ready, running, done", () => {
    let entries = offerEntries([action("a")], []);
    expect(canRunAction(entries, "a", false)).toBe(true);
    entries = beginAction(entries, "a") ?? [];
    expect(entries[0].status).toBe("running");
    expect(beginAction(entries, "a")).toBeNull();
    entries = finishAction(entries, "a");
    expect(entries[0].status).toBe("done");
    expect(canRunAction(entries, "a", false)).toBe(false);
  });

  it("does not start while another run is busy or for an unknown id", () => {
    const entries = offerEntries([action("a")], []);
    expect(canRunAction(entries, "a", true)).toBe(false);
    expect(canRunAction(entries, "missing", false)).toBe(false);
    expect(beginAction(entries, "missing")).toBeNull();
  });

  it("keeps a running or done status when the list is offered again", () => {
    let entries = offerEntries([action("a"), action("b")], []);
    entries = finishAction(beginAction(entries, "a") ?? [], "a");
    entries = beginAction(entries, "b") ?? [];
    const again = offerEntries([action("a"), action("b"), action("c")], entries);
    expect(again.map((e) => e.status)).toEqual(["done", "running", "ready"]);
  });
});
