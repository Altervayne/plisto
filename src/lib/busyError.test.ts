// -- Test Imports --
import { describe, expect, it } from "vitest";

// -- Unit Imports --
import { busyKind, isUnfinishedWrites } from "./busyError";

describe("busyKind", () => {
  it("names the scan lock, however the rejection is wrapped", () => {
    expect(busyKind("a scan is already running")).toBe("scan");
    expect(busyKind(new Error("a scan is already running"))).toBe("scan");
  });

  it("names a running file write apart from a scan", () => {
    expect(busyKind("a file write is running")).toBe("fileWrite");
    expect(busyKind(new Error("a file write is running"))).toBe("fileWrite");
  });

  it("reads any other failure as not busy", () => {
    expect(busyKind("index is unavailable")).toBeNull();
    expect(busyKind(undefined)).toBeNull();
    expect(busyKind({ code: 5 })).toBeNull();
  });
});

describe("isUnfinishedWrites", () => {
  it("matches the root refusal and nothing else", () => {
    expect(isUnfinishedWrites("unfinished writes")).toBe(true);
    expect(isUnfinishedWrites(new Error("unfinished writes"))).toBe(true);
    expect(isUnfinishedWrites("a file write is running")).toBe(false);
  });
});
