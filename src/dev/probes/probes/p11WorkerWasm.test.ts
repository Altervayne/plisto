// -- Test Imports --
import { describe, expect, it } from "vitest";

// -- Unit Imports --
import { judgeWorkerWasm } from "./p11WorkerWasm";

describe("judgeWorkerWasm", () => {
  it("is measured when at least one host answered", () => {
    expect(judgeWorkerWasm([true, true])).toBe("measured");
    expect(judgeWorkerWasm([false, true])).toBe("measured");
  });

  it("is invalid when every host was silent or none ran", () => {
    expect(judgeWorkerWasm([false, false])).toBe("invalid");
    expect(judgeWorkerWasm([])).toBe("invalid");
  });
});
