// -- Test Imports --
import { describe, expect, it, vi } from "vitest";

// -- Unit Imports --
import { runWrite } from "./replaceRun";
import type { RunSteps } from "./replaceRun";

const steps = (over: Partial<RunSteps<string>> = {}): RunSteps<string> => ({
  busy: () => false,
  blocked: () => null,
  stopPreview: () => Promise.resolve(),
  cancelAsked: () => false,
  call: vi.fn(() => Promise.resolve("ok")),
  ...over,
});

describe("runWrite", () => {
  it("calls the back end and hands back its result", async () => {
    expect(await runWrite(steps())).toEqual({ kind: "done", result: "ok" });
  });

  it("never calls the back end while blocked, before or after the preview stops", async () => {
    const early = steps({ blocked: () => "inUse" });
    expect(await runWrite(early)).toEqual({ kind: "blocked", why: "inUse" });
    expect(early.call).not.toHaveBeenCalled();

    let checks = 0;
    const late = steps({ blocked: () => (checks++ > 0 ? "changed" : null) });
    expect(await runWrite(late)).toEqual({ kind: "blocked", why: "changed" });
    expect(late.call).not.toHaveBeenCalled();
  });

  it("never calls the back end while another write is in flight", async () => {
    const held = steps({ busy: () => true });
    expect(await runWrite(held)).toEqual({ kind: "blocked", why: "busy" });
    expect(held.call).not.toHaveBeenCalled();
  });

  it("holds a Cancel clicked while the preview stops, never starting the run", async () => {
    let asked = false;
    const held = steps({
      stopPreview: () => {
        asked = true;
        return Promise.resolve();
      },
      cancelAsked: () => asked,
    });
    expect(await runWrite(held)).toEqual({ kind: "cancelled" });
    expect(held.call).not.toHaveBeenCalled();
  });

  it("starts the run even when the preview fails to stop", async () => {
    const run = steps({ stopPreview: () => Promise.reject(new Error("gone")) });
    expect(await runWrite(run)).toEqual({ kind: "done", result: "ok" });
  });

  it("reads only the explicit cancel as a clean cancel", async () => {
    const cancelled = steps({ call: () => Promise.reject({ kind: "cancelled" }) });
    expect(await runWrite(cancelled)).toEqual({ kind: "cancelled" });

    const locked = steps({ cancelAsked: () => false, call: () => Promise.reject("locked") });
    expect(await runWrite(locked)).toEqual({ kind: "failed", failure: { kind: "locked", code: null } });
  });
});
