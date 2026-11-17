// -- Test Imports --
import { describe, expect, it } from "vitest";

// -- Unit Imports --
import {
  caseId,
  caseMatrix,
  crossCheckPasted,
  judgeControls,
  clippedPatches,
  heldCases,
  holdActions,
  judgeP1,
  pasteLine,
  reconcile,
  worstFailure,
  type RunRecord,
  type CaseResult,
  type ControlReadings,
  type HeldSetup,
} from "./p01Blend";
import "../fixtures/pattern.js";

// -- Type Imports --
import type { DiffStats, Rect, Rgba } from "../pixelDiff";
import type { HoldRequest, PastedLayout, ProbeContext } from "../types";

const ok = (max: number, over = 0): DiffStats => ({ valid: true, max, over, p999: 0, compared: 100 });
const bad = (reason: string): DiffStats => ({ valid: false, reason });

const goodControls = (): ControlReadings => ({
  nullLight: ok(0),
  nullDark: ok(0),
  solid: ok(0),
  solidWebgl: ok(0),
  solid2d: ok(1),
  sensitivity: ok(87),
  negativeScreen: ok(100),
  negativeMultiply: ok(40),
});

const casesAt = (max: number): CaseResult[] => caseMatrix().map((c) => ({ id: caseId(c), diff: ok(max) }));

const input = (over: Partial<Parameters<typeof judgeP1>[0]> = {}) => ({
  controls: goodControls(),
  frame: casesAt(1),
  offscreen: { available: true as const, cases: casesAt(1) },
  captureNote: "capture device-sized (scale 1.25)",
  expected: 32,
  ...over,
});

describe("case matrix", () => {
  it("has 32 distinct cases per subject", () => {
    const ids = caseMatrix().map(caseId);
    expect(ids).toHaveLength(32);
    expect(new Set(ids).size).toBe(32);
    expect(ids).toContain("multiply/light/webgl/dip0.5");
  });
});

describe("pattern fit", () => {
  const patches: Rect[] = globalThis.probePattern.patches().map((p) => ({ x: p.x, y: p.y, w: p.w, h: p.h }));

  it("shows every patch of the real pattern whole in a 478 x 268 slot", () => {
    expect(patches).toHaveLength(32);
    expect(clippedPatches(patches, 478, 268)).toEqual([]);
  });

  it("names the patches a smaller slot cuts off", () => {
    expect(clippedPatches(patches, 478, 200).length).toBeGreaterThan(0);
  });
});

describe("controls", () => {
  it("hold for good readings", () => {
    expect(judgeControls(goodControls()).ok).toBe(true);
  });
  it("fail when solid is off by more than 1", () => {
    expect(judgeControls({ ...goodControls(), solid: ok(2) }).ok).toBe(false);
  });
  it("fail when a frame canvas does not match the reference canvas, per API", () => {
    const webgl = judgeControls({ ...goodControls(), solidWebgl: ok(40) });
    expect(webgl.ok).toBe(false);
    expect(webgl.lines.join("\n")).toContain("WebGL canvas");
    const flat = judgeControls({ ...goodControls(), solid2d: ok(40) });
    expect(flat.ok).toBe(false);
    expect(flat.lines.join("\n")).toContain("2D canvas");
  });
  it("accept a null reading at its limit of 2 and refuse 3", () => {
    expect(judgeControls({ ...goodControls(), nullLight: ok(2) }).ok).toBe(true);
    expect(judgeControls({ ...goodControls(), nullLight: ok(3) }).ok).toBe(false);
  });
  it("fail when sensitivity is flat", () => {
    expect(judgeControls({ ...goodControls(), sensitivity: ok(20) }).ok).toBe(false);
  });
  it("fail when a negative control passes", () => {
    expect(judgeControls({ ...goodControls(), negativeMultiply: ok(2) }).ok).toBe(false);
  });
  it("fail when a control cannot be read", () => {
    expect(judgeControls({ ...goodControls(), nullDark: bad("scale") }).ok).toBe(false);
  });
});

describe("judgeP1", () => {
  it("passes 32 good cases behind good controls", () => {
    const out = judgeP1(input());
    expect(out.state).toBe("pass");
    expect(out.lines[0]).toContain("32/32");
  });

  it("is invalid when a control fails, whatever the cases say", () => {
    expect(judgeP1(input({ controls: { ...goodControls(), solid: ok(30) } })).state).toBe("invalid");
  });

  it("is invalid when a negative control passes", () => {
    expect(judgeP1(input({ controls: { ...goodControls(), negativeScreen: ok(0) } })).state).toBe("invalid");
  });

  it("fails naming a case at 3", () => {
    const frame = casesAt(1);
    frame[5] = { id: frame[5].id, diff: ok(3, 9) };
    const out = judgeP1(input({ frame }));
    expect(out.state).toBe("fail");
    expect(out.lines.join("\n")).toContain(frame[5].id);
    expect(out.lines.join("\n")).toContain("over>2 9 p99.9 0");
  });

  it("counts a case at exactly 2 as within", () => {
    const frame = casesAt(2);
    expect(judgeP1(input({ frame })).state).toBe("pass");
  });

  it("is invalid, not fail, when a normal blend misses", () => {
    const frame = casesAt(0);
    const at = frame.findIndex((c) => c.id.startsWith("normal/"));
    frame[at] = { id: frame[at].id, diff: ok(30, 8) };
    const out = judgeP1(input({ frame }));
    expect(out.state).toBe("invalid");
    expect(out.lines[0]).toContain("does not show the frame's canvas as the reference shows its own");
  });

  it("is invalid for a normal miss at full opacity on either API", () => {
    const frame = casesAt(0);
    const at = frame.findIndex((c) => c.id === "normal/dark/2d/dip1");
    frame[at] = { id: frame[at].id, diff: ok(30, 8) };
    expect(judgeP1(input({ frame })).state).toBe("invalid");
  });

  it("fails, as an opacity result, for a normal miss at half opacity", () => {
    const frame = casesAt(0);
    const at = frame.findIndex((c) => c.id === "normal/light/webgl/dip0.5");
    frame[at] = { id: frame[at].id, diff: ok(30, 8) };
    const out = judgeP1(input({ frame }));
    expect(out.state).toBe("fail");
    expect(out.lines.join("\n")).toContain("an opacity result, not a blend-mode result");
  });

  it("states how many offscreen cases ran when they stopped", () => {
    const cases = casesAt(0).slice(0, 3);
    cases[2] = { id: cases[2].id, diff: bad("no drawn answer after 4000 ms") };
    const out = judgeP1(input({ offscreen: { available: true, cases, stopped: "no drawn answer after 4000 ms" } }));
    expect(out.state).toBe("pass");
    expect(out.lines.join("\n")).toContain("3 of 32 ran, the rest n/a (no drawn answer after 4000 ms)");
  });

  it("names both the unreadable and the failed cases", () => {
    const frame = casesAt(0);
    const screen = frame.findIndex((c) => c.id.startsWith("screen/"));
    const multiply = frame.findIndex((c) => c.id.startsWith("multiply/"));
    frame[screen] = { id: frame[screen].id, diff: bad("moved") };
    frame[multiply] = { id: frame[multiply].id, diff: ok(9, 3) };
    const out = judgeP1(input({ frame }));
    expect(out.state).toBe("invalid");
    const text = out.lines.join("\n");
    expect(text).toContain(frame[screen].id);
    expect(text).toContain(frame[multiply].id);
    expect(text).toContain("over>2 3");
  });

  it("is invalid when a case could not be compared", () => {
    const frame = casesAt(0);
    frame[0] = { id: frame[0].id, diff: bad("scale") };
    expect(judgeP1(input({ frame })).state).toBe("invalid");
  });

  it("is invalid when cases are missing", () => {
    expect(judgeP1(input({ frame: casesAt(0).slice(0, 31) })).state).toBe("invalid");
  });

  it("reports the offscreen cases apart and as n/a when refused", () => {
    const out = judgeP1(input({ offscreen: { available: false, reason: "transfer refused" }, frame: casesAt(0) }));
    expect(out.state).toBe("pass");
    expect(out.lines.join("\n")).toContain("offscreen canvas: n/a (transfer refused)");
  });

  it("does not let failing offscreen cases change the state", () => {
    const out = judgeP1(input({ offscreen: { available: true, cases: casesAt(50) } }));
    expect(out.state).toBe("pass");
    expect(out.lines.join("\n")).toContain("0/32");
  });
});

// ---- Pasted screenshot ----

const DPR = 1.25;
const layout: PastedLayout = {
  region: { w: 160, h: 100 },
  reference: { x: 16, y: 16, w: 48, h: 32 },
  subject: { x: 88, y: 16, w: 48, h: 32 },
};

function fill(img: Rgba, x: number, y: number, w: number, h: number, rgb: [number, number, number]): void {
  for (let j = y; j < y + h; j++) {
    for (let i = x; i < x + w; i++) img.data.set([...rgb, 255], (j * img.width + i) * 4);
  }
}

/** A screenshot at device size with four marks of `mark` pixels at the corners of a region at (20, 20). */
function screenshot(mark: number, scale = DPR): Rgba {
  const img: Rgba = { width: 400, height: 300, data: new Uint8ClampedArray(400 * 300 * 4) };
  fill(img, 0, 0, 400, 300, [90, 90, 90]);
  const w = Math.round(160 * scale);
  const h = Math.round(100 * scale);
  for (const [x, y] of [
    [20, 20],
    [20 + w - mark, 20],
    [20, 20 + h - mark],
    [20 + w - mark, 20 + h - mark],
  ]) {
    fill(img, x, y, mark, mark, [255, 0, 255]);
  }
  return img;
}

describe("crossCheckPasted", () => {
  const patch: Rect[] = [{ x: 8, y: 8, w: 24, h: 16 }];

  it("compares the two stages of a device-size screenshot", () => {
    const img = screenshot(10);
    expect(crossCheckPasted(img, DPR, layout, patch)).toMatchObject({ valid: true, max: 0 });
    fill(img, 20 + 110 + 20, 20 + 20 + 10, 20, 10, [200, 40, 40]);
    const diff = crossCheckPasted(img, DPR, layout, patch);
    expect(diff.valid && diff.max).toBeGreaterThan(50);
  });

  it("accepts marks that read about 10 percent small", () => {
    expect(crossCheckPasted(screenshot(9), DPR, layout, patch).valid).toBe(true);
  });

  it("rejects a screenshot at another scale", () => {
    expect(crossCheckPasted(screenshot(12, 1.5), DPR, layout, patch).valid).toBe(false);
  });

  it("rejects a picture without its marks", () => {
    const img = screenshot(10);
    fill(img, 20, 20, 10, 10, [90, 90, 90]);
    expect(crossCheckPasted(img, DPR, layout, patch)).toEqual({ valid: false, reason: "registration marks not found" });
  });
});

// ---- Held cases ----

const noPrepare = async (): Promise<HeldSetup> => ({ patches: [], release() {} });
const record = (state: RunRecord["state"] = "not run"): RunRecord => ({ state });

describe("held cases", () => {
  it("offers screen on dark and multiply on light", () => {
    expect(heldCases().map((h) => h.id)).toEqual(["hold-screen-dark", "hold-multiply-light"]);
    expect(holdActions(noPrepare, record()).map((a) => a.label)).toEqual([
      "Hold for screenshot: screen/dark/webgl/dip1",
      "Hold for screenshot: multiply/light/webgl/dip1",
    ]);
  });

  it("adds the worst failing case as a third action", () => {
    const frame = casesAt(1);
    frame[9] = { id: frame[9].id, diff: ok(40, 5) };
    const worst = worstFailure(frame);
    expect(worst && caseId(worst)).toBe(frame[9].id);
    const actions = holdActions(noPrepare, record("fail"), worst);
    expect(actions.map((a) => a.id)).toEqual(["hold-screen-dark", "hold-multiply-light", "hold-worst"]);
    expect(actions[2].label).toBe(`Hold for screenshot: ${frame[9].id}`);
  });

  it("offers no worst case when nothing fails", () => {
    expect(worstFailure(casesAt(2))).toBeNull();
  });

  it("words the paste result for a match, a mismatch and an unreadable picture", () => {
    expect(pasteLine("c", ok(1, 0))).toContain("c: pasted screenshot within 2/255");
    expect(pasteLine("c", ok(9, 4))).toContain("beyond 2/255");
    const line = pasteLine("c", bad("registration marks not found"));
    expect(line).toContain("could not be compared: registration marks not found");
    expect(line).toContain("marks scale 0.85 to 1.05 of dpr");
  });

  it("demotes a capture pass that a screenshot contradicts", () => {
    expect(reconcile("pass", ok(9, 4)).state).toBe("invalid");
    expect(pasteLine("c", ok(9, 4), "pass")).toContain("RUN INVALID");
  });

  it("keeps a pass the screenshot agrees with or cannot judge", () => {
    expect(reconcile("pass", ok(2)).state).toBe("pass");
    expect(reconcile("pass", bad("marks")).state).toBe("pass");
  });

  it("never upgrades a fail or an invalid run", () => {
    expect(reconcile("fail", ok(0)).state).toBe("fail");
    expect(reconcile("invalid", ok(0)).state).toBe("invalid");
    expect(reconcile("not run", ok(0)).state).toBe("not run");
  });

  const fakeContext = (hold: (r: HoldRequest) => Promise<void>) => ({ hold }) as unknown as ProbeContext;

  it("answers a paste through the cross-check and releases when hold resolves", async () => {
    let released = 0;
    const setup: HeldSetup = { patches: [{ x: 8, y: 8, w: 24, h: 16 }], release: () => void released++ };
    const run = record("pass");
    const action = holdActions(async () => setup, run)[0];
    let line = "";
    const verdict = await action.run(
      fakeContext(async (request) => {
        const img = screenshot(10);
        const first = await request.onPaste({ image: img, dpr: DPR, layout });
        expect(typeof first).toBe("string");
        line = first as string;
        fill(img, 20 + 110 + 20, 20 + 20 + 10, 20, 10, [200, 40, 40]);
        const second = await request.onPaste({ image: img, dpr: DPR, layout });
        // The demotion travels with the paste, so it does not wait for the hold to end.
        expect(second).toMatchObject({ verdict: { state: "invalid" } });
        line += " | " + (second as { line: string }).line;
      }),
    );
    expect(line).toContain("within 2/255");
    expect(line).toContain("beyond 2/255");
    expect(line).toContain("RUN INVALID");
    expect(run.state).toBe("invalid");
    expect(verdict).toMatchObject({ state: "invalid" });
    expect(released).toBe(1);
  });

  it("releases when hold rejects", async () => {
    let released = 0;
    const action = holdActions(async () => ({ patches: [], release: () => void released++ }), record())[1];
    await expect(action.run(fakeContext(() => Promise.reject(new Error("deadline"))))).rejects.toThrow("deadline");
    expect(released).toBe(1);
  });
});
