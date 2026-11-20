// -- Test Imports --
import { beforeEach, describe, expect, it, vi } from "vitest";

// A one-component hook host: state slots survive between calls, setters write straight through.
const host = vi.hoisted(() => ({ slots: [] as unknown[], at: 0 }));
vi.mock("react", () => ({
  useState: (init: unknown) => {
    const k = host.at++;
    if (!(k in host.slots)) host.slots[k] = init;
    return [
      host.slots[k],
      (v: unknown) => {
        host.slots[k] = typeof v === "function" ? (v as (p: unknown) => unknown)(host.slots[k]) : v;
      },
    ];
  },
  useCallback: (fn: unknown) => fn,
}));

const store = vi.hoisted(() => ({
  plan: vi.fn(),
  restore: vi.fn(),
}));
vi.mock("../../../state/restorePoints/store", () => ({
  useRestorePointsStore: (select: (s: Record<string, unknown>) => unknown) => select(store),
}));

// -- Unit Imports --
import { useRestoreFlow } from "./useRestoreFlow";

// -- Type Imports --
import type { RestorePointRow, RestoreSummary } from "../../../types";

const render = () => {
  host.at = 0;
  return useRestoreFlow();
};

const row = { file: "p.sqlite" } as RestorePointRow;
const summary = { albums: 1 } as RestoreSummary;

beforeEach(() => {
  host.slots = [];
  host.at = 0;
  store.plan.mockReset();
  store.restore.mockReset();
});

describe("useRestoreFlow", () => {
  it("opens the sheet with the dry run's summary when the plan is ready", async () => {
    store.plan.mockResolvedValue({ kind: "ready", summary });
    await render().start(row);
    const after = render();
    expect(store.plan).toHaveBeenCalledWith("p.sqlite");
    expect(after.pending).toEqual({ row, summary });
    expect(after.planning).toBeNull();
    expect(after.planFailure).toBeNull();
  });

  it("holds the point while the dry run is in flight", async () => {
    let finish: (v: unknown) => void = () => {};
    store.plan.mockReturnValue(new Promise((resolve) => (finish = resolve)));
    const started = render().start(row);
    expect(render().planning).toBe("p.sqlite");
    finish({ kind: "ready", summary });
    await started;
    expect(render().planning).toBeNull();
  });

  it("keeps the failure, and no sheet, when the plan is refused", async () => {
    const failure = { key: "newer", detail: "9" };
    store.plan.mockResolvedValue({ kind: "refused", failure });
    await render().start(row);
    const after = render();
    expect(after.planFailure).toEqual(failure);
    expect(after.pending).toBeNull();
  });

  it("notes which point is restoring and asks the store to restore it", () => {
    render().run("p.sqlite");
    expect(render().restoring).toBe("p.sqlite");
    expect(store.restore).toHaveBeenCalledWith("p.sqlite");
  });

  it("clears the sheet on cancel and the failure on dismiss", async () => {
    store.plan.mockResolvedValueOnce({ kind: "ready", summary });
    await render().start(row);
    render().cancel();
    expect(render().pending).toBeNull();

    store.plan.mockResolvedValueOnce({ kind: "refused", failure: { key: "busy", detail: null } });
    await render().start(row);
    expect(render().planFailure).not.toBeNull();
    render().dismissPlanFailure();
    expect(render().planFailure).toBeNull();
  });
});
