// -- Test Imports --
import { describe, expect, it, vi } from "vitest";

// -- Unit Imports --
import { createLocateFlow, stepAfterRelocate } from "./locateFlow";

// -- Type Imports --
import type { LocateDeps, LocateStep } from "./locateFlow";
import type { RelocateResult } from "../../state/relocate";
import type { RelocatePreview, ScanSummary } from "../../types";

const MOVE: RelocatePreview = { kind: "move", total: 200, sampled: 48, matched: 48, partial: false };

const summary = (missing: number): ScanSummary => ({
  total: 200,
  seen: 200 - missing,
  inserted: 0,
  updated: 0,
  skipped: 0,
  removed: 0,
  missing,
  returned: 0,
  errors: 0,
  cancelled: false,
  offline_roots: [],
  deferred: 0,
});

const done = (missing: number): RelocateResult => ({
  kind: "done",
  summary: summary(missing),
  merged: false,
  albums_replaced: 0,
});

/** A flow wired to fakes, recording every step it emits. */
function setup(overrides: Partial<LocateDeps> = {}) {
  const deps: LocateDeps = {
    pickFolder: vi.fn(async () => "D:\\Music"),
    preview: vi.fn(async () => MOVE),
    relocate: vi.fn(async () => done(0)),
    ...overrides,
  };
  const steps: LocateStep[] = [];
  const flow = createLocateFlow(7, deps, (s) => steps.push(s));
  return { deps, steps, flow, last: () => steps[steps.length - 1] };
}

describe("locate flow", () => {
  it("walks pick, check, confirm, relocate to a receipt", async () => {
    const { flow, steps, last, deps } = setup();
    await flow.pick("Music");
    expect(steps.map((s) => s.kind)).toEqual(["checking", "confirm"]);
    expect(deps.preview).toHaveBeenCalledWith(7, "D:\\Music");

    await flow.confirm();
    expect(steps.map((s) => s.kind)).toEqual(["checking", "confirm", "running", "done"]);
    expect(deps.relocate).toHaveBeenCalledWith(7, "D:\\Music");
    expect(last()).toEqual({ kind: "done", name: "Music", folder: "D:\\Music", missing: 0 });
  });

  it("leaves everything alone when the picker is cancelled", async () => {
    const { flow, steps, deps } = setup({ pickFolder: vi.fn(async () => null) });
    await flow.pick("Music");
    expect(steps).toEqual([]);
    expect(deps.preview).not.toHaveBeenCalled();
  });

  it("shows a refused preview inline and never reaches confirm", async () => {
    const reason = { code: "no_match", sampled: 40, matched: 3 } as const;
    const { flow, last } = setup({ preview: vi.fn(async (): Promise<RelocatePreview> => ({ kind: "refused", reason })),
    });
    await flow.pick("Music");
    expect(last()).toEqual({ kind: "refused", name: "Music", folder: "D:\\Music", reason });
    await flow.confirm();
    expect(last().kind).toBe("refused");
  });

  it("reads a rejected preview as a failed refusal", async () => {
    const { flow, last } = setup({
      preview: vi.fn(async () => {
        throw new Error("boom");
      }),
    });
    await flow.pick("Music");
    expect(last()).toMatchObject({ kind: "refused", reason: { code: "failed" } });
  });

  it("carries a merge preview into confirm", async () => {
    const merge: RelocatePreview = {
      kind: "merge",
      other_id: 2,
      other_tracks: 90,
      total: 100,
      matched: 90,
      albums_replaced: 3,
      partial: false,
    };
    const { flow, last } = setup({ preview: vi.fn(async () => merge) });
    await flow.check("Music", "E:\\Library");
    expect(last()).toEqual({ kind: "confirm", name: "Music", folder: "E:\\Library", plan: merge });
  });

  it("records the receipt's missing count from the scan summary", async () => {
    const { flow, last } = setup({ relocate: vi.fn(async () => done(12)) });
    await flow.pick("Music");
    await flow.confirm();
    expect(last()).toMatchObject({ kind: "done", missing: 12 });
  });

  it("shows a refused relocate and a busy one inline", async () => {
    const reason = { code: "overlap", other: "D:\\Other" } as const;
    const refused = setup({ relocate: vi.fn(async (): Promise<RelocateResult> => ({ kind: "refused", reason })),
    });
    await refused.flow.pick("Music");
    await refused.flow.confirm();
    expect(refused.last()).toMatchObject({ kind: "refused", reason });

    const busy = setup({ relocate: vi.fn(async (): Promise<RelocateResult> => ({ kind: "busy" })),
    });
    await busy.flow.pick("Music");
    await busy.flow.confirm();
    expect(busy.last()).toMatchObject({ kind: "refused", reason: { code: "busy" } });
  });

  it("leaves the flow when the rescan failed after the commit", () => {
    expect(stepAfterRelocate("Music", "D:\\Music", { kind: "failed" })).toEqual({ kind: "idle" });
  });

  it("drops a slow check once the flow was cancelled", async () => {
    let release: (p: RelocatePreview) => void = () => {};
    const { flow, steps, last } = setup({
      preview: vi.fn(() => new Promise<RelocatePreview>((r) => (release = r))),
    });
    const pending = flow.pick("Music");
    await vi.waitFor(() => expect(steps.map((s) => s.kind)).toEqual(["checking"]));
    flow.cancel();
    release(MOVE);
    await pending;
    expect(last()).toEqual({ kind: "idle" });
  });

  it("lets a newer check win over an older response", async () => {
    const releases: ((p: RelocatePreview) => void)[] = [];
    const { flow, steps, last } = setup({
      preview: vi.fn(() => new Promise<RelocatePreview>((r) => releases.push(r))),
    });
    const first = flow.check("Music", "D:\\One");
    const second = flow.check("Music", "D:\\Two");
    releases[1](MOVE);
    releases[0]({ ...MOVE, matched: 1 });
    await Promise.all([first, second]);
    expect(last()).toMatchObject({ kind: "confirm", folder: "D:\\Two" });
    expect(steps.filter((s) => s.kind === "confirm")).toHaveLength(1);
  });

  it("drops a response that lands after dispose", async () => {
    let release: (p: RelocatePreview) => void = () => {};
    const { flow, steps } = setup({
      preview: vi.fn(() => new Promise<RelocatePreview>((r) => (release = r))),
    });
    const pending = flow.check("Music", "D:\\Music");
    flow.dispose();
    release(MOVE);
    await pending;
    expect(steps.map((s) => s.kind)).toEqual(["checking"]);
  });
});
