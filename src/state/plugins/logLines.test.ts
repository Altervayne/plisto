// -- Test Imports --
import { describe, expect, it } from "vitest";

// -- Unit Imports --
import { parseLogLine } from "./logLines";

const at = (h: number, m: number, s: number, ms: number) => new Date(2024, 0, 2, h, m, s, ms).getTime();

describe("parseLogLine", () => {
  it("splits a Plisto line into time, level and text", () => {
    const line = parseLogLine(`${at(14, 2, 11, 482)} INFO Loaded the provider`);
    expect(line).toEqual({ time: "14:02:11.482", level: "INFO", text: "Loaded the provider", warn: false });
  });

  it("marks warnings and errors", () => {
    expect(parseLogLine(`${at(9, 5, 1, 7)} WARN slow`).warn).toBe(true);
    expect(parseLogLine(`${at(9, 5, 1, 7)} ERROR broke`).warn).toBe(true);
    expect(parseLogLine(`${at(9, 5, 1, 7)} HOST stopped`).warn).toBe(false);
    expect(parseLogLine(`${at(9, 5, 1, 7)} DEBUG x`).time).toBe("09:05:01.007");
  });

  it("keeps any other line as plain text", () => {
    expect(parseLogLine("thread 'main' panicked")).toEqual({
      time: null,
      level: null,
      text: "thread 'main' panicked",
      warn: false,
    });
    expect(parseLogLine("12 INFO too short a stamp").time).toBeNull();
    expect(parseLogLine("").text).toBe("");
  });
});
