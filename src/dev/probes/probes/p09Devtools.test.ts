// -- Test Imports --
import { describe, expect, it } from "vitest";

// -- Unit Imports --
import { CATALOG, runAllOrder } from "../catalog";
import { awaitChoice } from "../ownerPrompt";
import { answerOutcome } from "./p09Devtools";

describe("P9 answers", () => {
  it("reads both answers as a measurement, each line carrying the answer", () => {
    expect(answerOutcome("yes").state).toBe("measured");
    expect(answerOutcome("no").state).toBe("measured");
    expect(answerOutcome("yes").lines[1]).toBe("owner answered yes: devtools reach the frame");
    expect(answerOutcome("no").lines[1]).toBe("owner answered no: devtools do not reach the frame");
  });

  it("gives no reading when the run ended without an answer", () => {
    expect(answerOutcome(null).state).toBe("invalid");
  });

  it("stays out of Run all", () => {
    expect(runAllOrder(CATALOG)).not.toContain("P9");
  });
});

describe("awaitChoice", () => {
  it("waits without a time limit and resolves with the answer", async () => {
    let choose: (a: "yes" | "no" | null) => void = () => {};
    const pending = awaitChoice<"yes" | "no" | null>(new AbortController().signal, null, (c) => (choose = c));
    choose("no");
    expect(await pending).toBe("no");
  });

  it("resolves null when the run's signal aborts", async () => {
    const stop = new AbortController();
    const pending = awaitChoice<"yes" | "no" | null>(stop.signal, null, () => {});
    stop.abort();
    expect(await pending).toBeNull();
  });
});
