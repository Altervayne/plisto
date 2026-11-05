// -- Test Imports --
import { describe, expect, it } from "vitest";

// -- Unit Imports --
import { IDLE, errorMessage, reduceUpdater, runCheck, shouldPrompt } from "./machine";

// -- Type Imports --
import type { UpdaterEvent, UpdaterState } from "./machine";

const update = { version: "2.5.0", notes: "What's new" };

const run = (events: UpdaterEvent[], from: UpdaterState = IDLE) => events.reduce(reduceUpdater, from);

describe("runCheck", () => {
  it("reads a resolved null as up to date", async () => {
    expect(await runCheck(async () => null)).toEqual({ type: "checked", update: null });
  });

  it("carries a found update", async () => {
    expect(await runCheck(async () => update)).toEqual({ type: "checked", update });
  });

  it("turns any rejection into a failure, never up to date", async () => {
    for (const reason of ["network down", new Error("bad manifest"), undefined, 42]) {
      const event = await runCheck(() => Promise.reject(reason));
      expect(event.type).toBe("checkFailed");
      expect(run([{ type: "check" }, event]).kind).toBe("error");
    }
  });
});

describe("reduceUpdater", () => {
  it("lands on up to date only from a null answer", () => {
    expect(run([{ type: "check" }, { type: "checked", update: null }])).toEqual({ kind: "upToDate" });
  });

  it("keeps a failed check's reason", () => {
    const state = run([{ type: "check" }, { type: "checkFailed", message: "offline" }]);
    expect(state).toEqual({ kind: "error", message: "offline", update: null });
  });

  it("walks available, downloading, ready", () => {
    const steps = run([
      { type: "check" },
      { type: "checked", update },
      { type: "download" },
      { type: "progress", progress: 0.4 },
    ]);
    expect(steps).toEqual({ kind: "downloading", update, progress: 0.4 });
    expect(reduceUpdater(steps, { type: "installed" })).toEqual({ kind: "ready", update });
  });

  it("keeps the update on a failed install so it can retry", () => {
    const failed = run([
      { type: "check" },
      { type: "checked", update },
      { type: "download" },
      { type: "installFailed", message: "signature mismatch" },
    ]);
    expect(failed).toEqual({ kind: "error", message: "signature mismatch", update });
    expect(reduceUpdater(failed, { type: "download" }).kind).toBe("downloading");
  });

  it("never lets a check interrupt a download", () => {
    const downloading = run([{ type: "check" }, { type: "checked", update }, { type: "download" }]);
    expect(reduceUpdater(downloading, { type: "check" })).toBe(downloading);
  });

  it("ignores a download with no update in hand", () => {
    expect(reduceUpdater(IDLE, { type: "download" })).toBe(IDLE);
    const failedCheck = run([{ type: "check" }, { type: "checkFailed", message: "x" }]);
    expect(reduceUpdater(failedCheck, { type: "download" })).toBe(failedCheck);
  });

  it("ignores a late answer once the check is no longer running", () => {
    expect(reduceUpdater(IDLE, { type: "checked", update: null })).toBe(IDLE);
  });
});

describe("shouldPrompt", () => {
  it("stays quiet for the dismissed version", () => {
    expect(shouldPrompt("2.5.0", "2.5.0")).toBe(false);
  });

  it("prompts for a newer version than the dismissed one", () => {
    expect(shouldPrompt("2.6.0", "2.5.0")).toBe(true);
  });

  it("prompts when nothing was dismissed", () => {
    expect(shouldPrompt("2.5.0", undefined)).toBe(true);
  });
});

describe("errorMessage", () => {
  it("reads strings and errors, and falls back otherwise", () => {
    expect(errorMessage("offline")).toBe("offline");
    expect(errorMessage(new Error("bad"))).toBe("bad");
    expect(errorMessage(null)).toBe("Unknown error");
  });
});
