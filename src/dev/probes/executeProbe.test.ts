// -- Test Imports --
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

// -- Unit Imports --
import { applyVerdict, canRunAction, createActionStore } from "./cardActions";
import { CATALOG } from "./catalog";
import { executeAction, executeProbe, UNCLEAN_NOTICE } from "./executeProbe";
import type { ActionDeps, ExecuteDeps } from "./executeProbe";
import { handlePaste } from "./pasteFlow";
import { buildReport } from "./report";
import { createThemeCell } from "./themeCell";

// -- Type Imports --
import type { CardAction, CardResult, HoldRequest, ProbeContext, ProbeModule, ProbeOutcome } from "./types";

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  vi.useRealTimers();
});

const GRACE = 5000;
const offered = (id: string): CardAction => ({ id, label: id, run: async () => {} });

function setup() {
  const puts: CardResult[] = [];
  const resets = { count: 0 };
  const prepares = { count: 0 };
  const notices: string[] = [];
  const deps: ExecuteDeps = {
    prepare: () => void prepares.count++,
    makeContext: (signal) => ({ signal }) as unknown as ProbeContext,
    put: (r) => puts.push(r),
    extraLines: () => [],
    resetStages: () => resets.count++,
    notice: (t) => notices.push(t),
    graceMs: GRACE,
  };
  return { puts, resets, prepares, notices, deps };
}

const last = <T,>(items: T[]): T | undefined => items[items.length - 1];

const probe = (run: (ctx: ProbeContext) => Promise<ProbeOutcome | void>, timeoutMs?: number): ProbeModule =>
  ({ id: "X", run, timeoutMs }) as unknown as ProbeModule;

/** A probe whose cleanup after an abort takes `cleanupMs` (never finishes when null). */
const slowCleanup = (cleanupMs: number | null) =>
  probe(
    (ctx) =>
      new Promise((resolve) => {
        ctx.signal.addEventListener("abort", () => {
          if (cleanupMs !== null) setTimeout(resolve, cleanupMs);
        });
      }),
    1000,
  );

describe("executeProbe: the next run waits for cleanup", () => {
  it("prepares before the probe runs", async () => {
    const { prepares, deps } = setup();
    let preparedAtStart = -1;
    await executeProbe(
      probe(async () => {
        preparedAtStart = prepares.count;
        return { state: "pass", lines: [] };
      }),
      new AbortController().signal,
      deps,
    );
    expect(preparedAtStart).toBe(1);
  });

  it("ends the card at once on stop but returns only after the probe settled, with no reset", async () => {
    const { puts, resets, notices, deps } = setup();
    const stop = new AbortController();
    let returned = false;
    void executeProbe(slowCleanup(2000), stop.signal, deps).then(() => (returned = true));
    await vi.advanceTimersByTimeAsync(100);
    stop.abort();
    await vi.advanceTimersByTimeAsync(0);
    expect(last(puts)?.state).toBe("stopped");
    expect(returned).toBe(false);
    await vi.advanceTimersByTimeAsync(1999);
    expect(returned).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    expect(returned).toBe(true);
    expect(resets.count).toBe(0);
    expect(notices).toEqual([]);
  });

  it("waits for a timed-out probe's cleanup the same way", async () => {
    const { puts, resets, deps } = setup();
    let returned = false;
    void executeProbe(slowCleanup(1500), new AbortController().signal, deps).then(() => (returned = true));
    await vi.advanceTimersByTimeAsync(1000);
    expect(last(puts)?.state).toBe("timed out");
    expect(returned).toBe(false);
    await vi.advanceTimersByTimeAsync(1500);
    expect(returned).toBe(true);
    expect(resets.count).toBe(0);
  });

  it("resets the stages and says so after the grace time when the probe never settles", async () => {
    const { puts, resets, notices, deps } = setup();
    const stop = new AbortController();
    let returned = false;
    void executeProbe(slowCleanup(null), stop.signal, deps).then(() => (returned = true));
    stop.abort();
    await vi.advanceTimersByTimeAsync(GRACE - 1);
    expect(returned).toBe(false);
    expect(resets.count).toBe(0);
    await vi.advanceTimersByTimeAsync(1);
    expect(returned).toBe(true);
    expect(resets.count).toBe(1);
    expect(notices).toEqual([UNCLEAN_NOTICE]);
    expect(last(puts)?.state).toBe("stopped");
  });

  it("does not wait after a probe that finished", async () => {
    const { puts, resets, deps } = setup();
    await executeProbe(probe(async () => ({ state: "pass", lines: ["ok"] })), new AbortController().signal, deps);
    expect(last(puts)).toEqual({ state: "pass", lines: ["ok"] });
    expect(resets.count).toBe(0);
  });
});

describe("executeAction", () => {
  const actionDeps = (over: Partial<ActionDeps> = {}): ActionDeps => ({
    prepare: () => {},
    makeContext: (signal) => ({ signal }) as unknown as ProbeContext,
    appendLine: () => {},
    applyVerdict: () => {},
    resetStages: () => {},
    notice: () => {},
    graceMs: GRACE,
    ...over,
  });

  it("notes how an action ended and resets after the grace time when it hangs", async () => {
    const lines: string[] = [];
    const notices: string[] = [];
    let resets = 0;
    const stop = new AbortController();
    const pending = executeAction(
      "Hold",
      () => new Promise<void>(() => {}),
      stop.signal,
      actionDeps({ appendLine: (l) => lines.push(l), resetStages: () => void resets++, notice: (t) => notices.push(t) }),
    );
    stop.abort();
    await vi.advanceTimersByTimeAsync(GRACE);
    await pending;
    expect(lines).toEqual(["Hold: stopped"]);
    expect(resets).toBe(1);
    expect(notices).toEqual([UNCLEAN_NOTICE]);
  });

  it("prepares first, and hands a returned verdict to the card but nothing when it returns none", async () => {
    const verdicts: unknown[] = [];
    let prepared = 0;
    const deps = actionDeps({ prepare: () => void prepared++, applyVerdict: (v) => verdicts.push(v) });
    await executeAction("A", async () => ({ state: "invalid", line: "screenshot disagrees" }), new AbortController().signal, deps);
    await executeAction("B", async () => {}, new AbortController().signal, deps);
    expect(prepared).toBe(2);
    expect(verdicts).toEqual([{ state: "invalid", line: "screenshot disagrees" }]);
  });
});

describe("the theme a probe restores", () => {
  it("is the one the next probe starts with, before the page renders", async () => {
    const stamped: string[] = [];
    // The page's own state only follows later; the cell is what the runner reads.
    const cell = createThemeCell("dark", (t) => stamped.push(t));
    const { deps } = setup();
    const seen: string[] = [];
    const withTheme: ExecuteDeps = {
      ...deps,
      makeContext: (signal) =>
        ({ signal, env: { theme: cell.get() }, setTheme: cell.set }) as unknown as ProbeContext,
    };
    const a = probe(async (ctx) => {
      try {
        ctx.setTheme("light");
        throw new Error("boom");
      } finally {
        ctx.setTheme(ctx.env.theme);
      }
    });
    const b = probe(async (ctx) => {
      seen.push(ctx.env.theme);
      return { state: "pass", lines: [] };
    });
    await executeProbe(a, new AbortController().signal, withTheme);
    await executeProbe(b, new AbortController().signal, withTheme);
    expect(seen).toEqual(["dark"]);
    expect(cell.get()).toBe("dark");
    expect(stamped).toEqual(["light", "dark"]);
  });

  it("takes the page's value when it renders without telling the page back", () => {
    const told: string[] = [];
    const cell = createThemeCell("dark", (t) => told.push(t));
    cell.adopt("light");
    expect(cell.get()).toBe("light");
    expect(told).toEqual([]);
  });
});

describe("a paste verdict reaches the card whatever ends the action", () => {
  const layout = { region: { w: 10, h: 10 }, reference: { x: 0, y: 0, w: 1, h: 1 }, subject: { x: 0, y: 0, w: 1, h: 1 } };
  const demoting = { line: "RUN INVALID: the screenshot disagrees", verdict: { state: "invalid" as const } };

  /**
   * A hold action whose `hold` is the real paste path: one image paste goes through `handlePaste`, and the
   * hold then waits for the end of the run. The page's card is `card`, changed by the same rules the page uses.
   */
  async function pasteThen(
    start: CardResult,
    answer: string | { line: string; verdict?: { state: CardResult["state"] } },
    end: "stop" | "timeout",
  ) {
    let card = start;
    const append = (_id: string, line: string) => void (card = { ...card, lines: [...card.lines, line] });
    const onCard = (_id: string, verdict: Parameters<typeof applyVerdict>[1]) => void (card = applyVerdict(card, verdict));
    const stop = new AbortController();
    const pending = executeAction("Hold", (ctx) => ctx.hold({ label: "case", onPaste: async () => answer }), stop.signal, {
      prepare: () => {},
      makeContext: (signal) =>
        ({
          signal,
          hold: async (request: HoldRequest) => {
            const handling = handlePaste(
              { id: "P1", request, layout, dpr: 1 },
              null,
              ["image/png"],
              () => new Blob(),
              { read: async () => ({ width: 1, height: 1, data: new Uint8ClampedArray(4) }), appendLine: append, applyVerdict: onCard },
            );
            await handling.done;
            await new Promise<void>((resolve) => signal.addEventListener("abort", () => resolve()));
          },
        }) as unknown as ProbeContext,
      appendLine: (line) => append("P1", line),
      applyVerdict: (v) => onCard("P1", v),
      resetStages: () => {},
      notice: () => {},
      graceMs: GRACE,
    });
    await vi.advanceTimersByTimeAsync(10);
    if (end === "stop") stop.abort();
    else await vi.advanceTimersByTimeAsync(600_000);
    await vi.advanceTimersByTimeAsync(GRACE);
    await pending;
    return card;
  }

  const report = (card: CardResult) =>
    buildReport(
      { version: "2.7.0", webview2: "1", dpr: 1, displayHz: 60, gl: "gl", theme: "dark" },
      CATALOG,
      new Map([["P1", card]]),
      new Set(["P1"]),
    );

  it.each(["stop", "timeout"] as const)("leaves an invalid card and report after a demoting paste then %s", async (end) => {
    const card = await pasteThen({ state: "pass", lines: ["32/32"] }, demoting, end);
    expect(card.state).toBe("invalid");
    expect(card.lines).toContain(demoting.line);
    expect(report(card)).toMatch(/^P1\s+INVALID\s/m);
  });

  it("only adds a line for a plain string answer", async () => {
    const card = await pasteThen({ state: "pass", lines: [] }, "plain note", "stop");
    expect(card.state).toBe("pass");
    expect(card.lines).toContain("plain note");
  });

  it("changes nothing when a pass verdict meets a fail card", async () => {
    const card = await pasteThen({ state: "fail", lines: [] }, { line: "looks fine", verdict: { state: "pass" } }, "stop");
    expect(card.state).toBe("fail");
  });
});

describe("offered actions survive the end of a run", () => {
  const ends: [string, (ctx: ProbeContext) => Promise<ProbeOutcome>, "stop" | "none", number | undefined][] = [
    ["pass", async () => ({ state: "pass", lines: [] }), "none", undefined],
    ["fail", async () => ({ state: "fail", lines: [] }), "none", undefined],
    ["invalid", async () => ({ state: "invalid", lines: [] }), "none", undefined],
    ["a throw", async () => Promise.reject(new Error("boom")), "none", undefined],
    ["stop", () => new Promise<ProbeOutcome>(() => {}), "stop", undefined],
    ["a timeout", () => new Promise<ProbeOutcome>(() => {}), "none", 1000],
  ];

  it.each(ends)("keeps the latest list after %s and runs it only while idle", async (_name, body, stopMode, timeoutMs) => {
    // The real store; `prepare` clears it as the runner's does at the start of each run.
    const store = createActionStore(() => {});
    const depsFor = (): ExecuteDeps => ({
      ...setup().deps,
      prepare: () => store.clear("P1"),
      makeContext: (signal) => ({ signal, offerActions: (list: CardAction[]) => store.offer("P1", list) }) as unknown as ProbeContext,
    });
    // An earlier run's leftovers must not reach this one.
    await executeProbe(
      probe(async (ctx) => {
        ctx.offerActions([offered("old")]);
        return { state: "pass", lines: [] };
      }),
      new AbortController().signal,
      depsFor(),
    );
    const stop = new AbortController();
    const m = probe(async (ctx) => {
      ctx.offerActions([offered("a")]);
      ctx.offerActions([offered("b"), offered("c")]);
      return body(ctx);
    }, timeoutMs);
    const pending = executeProbe(m, stop.signal, depsFor());
    await vi.advanceTimersByTimeAsync(10);
    if (stopMode === "stop") stop.abort();
    await vi.advanceTimersByTimeAsync(GRACE + 2000);
    await pending;
    expect(store.get("P1").map((e) => e.action.id)).toEqual(["b", "c"]);
    expect(canRunAction(store.get("P1"), "b", true)).toBe(false);
    expect(store.begin("P1", "b")?.status).toBe("running");
    expect(store.begin("P1", "b")).toBeNull();
  });
});
