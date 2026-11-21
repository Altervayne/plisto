import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { MINE, fakeCanvas, fakeGl, harness, testCandidate, testInit } from "./fixtures";
import { candidateForm } from "./forms/candidate";
import { rawForm } from "./forms/raw";
import { DT_MAX } from "./transport";

import type { VisFrame } from "./frame";
import type { Kit } from "../components/player/visualizers/gl/kit";

const shownCount = (log: string[]) => log.filter((e) => e === "shown").length;
const drawCount = (log: string[]) => log.filter((e) => e === "draw" || e === "shown").length;

describe("a GL mount", () => {
  beforeEach(() => {
    vi.stubGlobal("window", { devicePixelRatio: 1 });
  });
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  function glHarness(opts: { trail?: boolean; parallel?: boolean; stage?: unknown[] } = {}) {
    const discover = { on: false };
    const drawn: VisFrame[] = [];
    const log: string[] = [];
    const { gl, state } = fakeGl(log, opts.parallel ?? true);
    const stage = opts.stage ?? [];
    const { canvas, listeners } = fakeCanvas(gl, stage);
    const made = { count: 0 };
    const build = testCandidate(discover, { trail: opts.trail, drawn });
    const factory = (kit: Kit) => {
      made.count++;
      return build(kit);
    };
    const mount = candidateForm(factory, { programs: [MINE] });
    const h = harness(mount(testInit()), () => {
      stage.push(canvas);
      return canvas;
    }, log);
    return { ...h, state, listeners, discover, drawn, stage, made };
  }

  it("queries no compile status before the driver reports a program finished", () => {
    const h = glHarness();
    for (let i = 0; i < 5; i++) h.tick();
    expect(h.log.filter((e) => e.startsWith("status:"))).toEqual([]);
    expect(h.log).not.toContain("shown");
    expect(h.sent.filter((m) => m.type === "ack").pop()).toEqual({ type: "ack", seq: 5, ms: 0 });
  });

  it("never polls a compile in the draw that submitted it when the parallel extension is missing", () => {
    const h = glHarness({ parallel: false });
    h.tick();
    h.tick();
    expect(h.log.filter((e) => e === "status:link")).toEqual([]);
    h.tick();
    expect(h.log).toContain("status:link");
    expect(h.log).toContain("shown");
  });

  it("finishes compiling on ticks alone and posts ready only after a frame is shown", () => {
    const h = glHarness();
    h.tick();
    h.tick();
    expect(h.sent.some((m) => m.type === "ready")).toBe(false);
    h.state.complete = () => true;
    h.tick();
    const shown = h.log.indexOf("shown");
    expect(shown).toBeGreaterThanOrEqual(0);
    expect(h.log.indexOf("post:ready")).toBeGreaterThan(shown);
    expect(h.sent.filter((m) => m.type === "ready")).toEqual([{ type: "ready", metered: true }]);
  });

  it("leaves the trail alone while a program found mid-draw is still compiling", () => {
    const h = glHarness({ trail: true });
    h.state.complete = (p) => !p.srcs.some((s) => s.includes("found later"));
    h.tick();
    h.tick();
    h.tick();
    const shownBefore = shownCount(h.log);
    expect(shownBefore).toBeGreaterThan(0);
    h.discover.on = true;
    h.tick();
    // The draw that found the program ran its trail pass; none runs after it until the program is done.
    const drawsAfterDiscovery = drawCount(h.log);
    for (let i = 0; i < 20; i++) h.tick();
    expect(drawCount(h.log)).toBe(drawsAfterDiscovery);
    expect(shownCount(h.log)).toBe(shownBefore);
    expect(h.sent.some((m) => m.type === "error")).toBe(false);
    h.state.complete = () => true;
    h.tick();
    expect(shownCount(h.log)).toBe(shownBefore + 1);
  });

  it("folds the beats and time of ticks whose draws waited into the next drawn frame", () => {
    const h = glHarness();
    for (let i = 0; i < 5; i++) h.tick(1);
    expect(h.drawn).toEqual([]);
    h.state.complete = () => true;
    h.tick(1);
    expect(h.drawn.map((f) => f.nBeats)).toEqual([6]);
    expect(h.drawn[0].dt).toBe(DT_MAX);
    h.tick(1);
    expect(h.drawn.map((f) => f.nBeats)).toEqual([6, 1]);
    expect(h.drawn[1].dt).toBeCloseTo(1 / 30);
  });

  it("reports a failed link as a compile error and stops", () => {
    const h = glHarness();
    h.state.linkOk = false;
    h.state.complete = () => true;
    h.tick();
    h.tick();
    h.tick();
    expect(h.sent.filter((m) => m.type === "error")).toEqual([
      { type: "error", stage: "compile", message: "link failed here" },
    ]);
    const acks = h.sent.filter((m) => m.type === "ack").length;
    h.tick();
    expect(h.sent.filter((m) => m.type === "ack").length).toBe(acks);
  });

  it("serves a still once compiling ends, reading the canvas in the same task", async () => {
    const h = glHarness();
    h.send({ type: "still", id: 7 });
    expect(h.snapshots).toEqual([]);
    h.runTimers();
    expect(h.snapshots).toEqual([]);
    h.state.complete = () => true;
    h.runTimers();
    expect(h.snapshots.length).toBe(1);
    await Promise.resolve();
    await Promise.resolve();
    expect(h.sent.find((m) => m.type === "still")).toEqual({ type: "still", id: 7, bitmap: {} });
    expect(h.sent.some((m) => m.type === "ready")).toBe(true);
  });

  it("refuses a still once ticks have run, and keeps drawing", () => {
    const h = glHarness();
    h.state.complete = () => true;
    h.tick();
    h.tick();
    h.tick();
    const drawn = h.drawn.length;
    const made = h.made.count;
    h.send({ type: "still", id: 3 });
    const reply = h.sent.find((m) => m.type === "still");
    expect(reply).toMatchObject({ type: "still", id: 3, bitmap: null });
    expect(reply && "error" in reply && typeof reply.error).toBe("string");
    expect(h.snapshots).toEqual([]);
    h.tick();
    expect(h.drawn.length).toBe(drawn + 1);
    // The still did not start the scene over with a fresh instance.
    expect(h.made.count).toBe(made);
    expect(h.sent.some((m) => m.type === "error")).toBe(false);
  });

  it("posts lost and stops when the context is lost, and a later dispose still closes the port", () => {
    const h = glHarness();
    const preventDefault = vi.fn();
    h.listeners.webglcontextlost({ preventDefault });
    expect(preventDefault).toHaveBeenCalled();
    expect(h.sent[h.sent.length - 1]).toEqual({ type: "lost" });
    h.tick();
    expect(h.sent.some((m) => m.type === "ack")).toBe(false);
    expect(h.closed()).toBe(0);
    h.send({ type: "dispose" });
    expect(h.closed()).toBe(1);
  });

  it("takes its canvas and listener out on dispose, so a second mount leaves one canvas", () => {
    const stage: unknown[] = [];
    const first = glHarness({ stage });
    expect(stage.length).toBe(1);
    first.send({ type: "dispose" });
    expect(first.closed()).toBe(1);
    expect(stage).toEqual([]);
    expect(first.listeners.webglcontextlost).toBeUndefined();
    const second = glHarness({ stage });
    second.state.complete = () => true;
    second.tick();
    second.tick();
    expect(stage.length).toBe(1);
  });
});

describe("a raw mount", () => {
  const noCanvas = () => {
    throw new Error("a raw mount makes no canvas");
  };

  it("is ready once its first frame returns, and reacts to updates", () => {
    const frame = vi.fn();
    const resize = vi.fn();
    const settings = vi.fn();
    const h = harness(rawForm({ frame, resize, settings })(testInit()), noCanvas);
    expect(h.sent).toEqual([]);
    h.tick();
    h.tick();
    expect(frame).toHaveBeenCalledTimes(1);
    expect(h.sent.map((m) => m.type)).toEqual(["ack", "ready"]);
    expect(h.sent[1]).toEqual({ type: "ready", metered: false });
    h.send({ type: "update", context: { settings: { speed: 2 } } });
    expect(settings).toHaveBeenCalledWith({ speed: 2 });
    expect(resize).not.toHaveBeenCalled();
  });

  it("reports a throwing frame as a draw error", () => {
    const frame = () => {
      throw new Error("boom");
    };
    const h = harness(rawForm({ frame })(testInit()), noCanvas);
    h.tick();
    h.tick();
    expect(h.sent[h.sent.length - 1]).toEqual({ type: "error", stage: "draw", message: "boom" });
  });

  it("posts a still returned as a bitmap, transferred to the first request", () => {
    const bitmap = { width: 4 } as unknown as ImageBitmap;
    const h = harness(rawForm({ frame: () => {}, still: () => bitmap })(testInit()), noCanvas);
    h.send({ type: "still", id: 1 });
    expect(h.sent).toEqual([{ type: "ready", metered: false }, { type: "still", id: 1, bitmap }]);
    expect(h.transfers[1]).toEqual([bitmap]);
    expect(h.snapshots).toEqual([]);
  });
});
