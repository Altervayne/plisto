import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { MINE, fakeCanvas, fakeGl, harness, testCandidate, testInit } from "./fixtures";
import { candidateForm } from "./forms/candidate";
import { rawForm } from "./forms/raw";
import { sceneForm } from "./forms/scene";
import { shaderForm } from "./forms/shader";

import { restSignal } from "../state/player/visualSignal";

import type { Mount } from "./lifecycle";

/** The first tick waits for an animation frame; compiling needs a few draws. */
const warm = (h: { tick: () => void }) => {
  for (let i = 0; i < 4; i++) h.tick();
};
const readbacks = (log: string[]) => log.filter((e) => e === "readback").length;

beforeEach(() => {
  vi.stubGlobal("window", { devicePixelRatio: 1 });
});
afterEach(() => {
  vi.unstubAllGlobals();
});

/** A GL kind that compiled at once, so every tick draws. */
function glKind(opts: { meter?: boolean }) {
  const log: string[] = [];
  const { gl, state } = fakeGl(log);
  state.complete = () => true;
  const { canvas } = fakeCanvas(gl);
  const mount = candidateForm(testCandidate({ on: false }), { programs: [MINE] })(testInit());
  return harness(mount, () => canvas, log, opts);
}

describe("metering at mount", () => {
  it("meters a GL form's canvas with no call from the kind when on", () => {
    const h = glKind({ meter: true });
    warm(h);
    expect(readbacks(h.log)).toBeGreaterThan(0);
    expect(h.sent.find((m) => m.type === "ready")).toEqual({ type: "ready", metered: true });
  });

  it("does no readback when off", () => {
    const h = glKind({ meter: false });
    warm(h);
    expect(readbacks(h.log)).toBe(0);
    expect(h.sent.find((m) => m.type === "ready")).toEqual({ type: "ready", metered: true });
  });

  it("starts and stops readback on a live switch", () => {
    const h = glKind({ meter: false });
    warm(h);
    h.send({ type: "meter", on: true });
    h.tick();
    h.tick();
    const during = readbacks(h.log);
    expect(during).toBeGreaterThan(0);
    h.send({ type: "meter", on: false });
    for (let i = 0; i < 5; i++) h.tick();
    expect(readbacks(h.log)).toBe(during);
    h.send({ type: "meter", on: true });
    h.tick();
    h.tick();
    h.tick();
    expect(readbacks(h.log)).toBeGreaterThan(during);
  });

  it("ignores a malformed meter message", () => {
    const h = glKind({ meter: false });
    h.send({ type: "meter", on: "yes" });
    warm(h);
    expect(readbacks(h.log)).toBe(0);
  });

  it("meters shader, scene and candidate forms alike", () => {
    for (const form of [
      shaderForm({ source: "void main() {}" }),
      sceneForm({ passes: [{ name: "a", fs: "#version 300 es\n// a" }] }),
    ]) {
      const log: string[] = [];
      const { gl, state } = fakeGl(log);
      state.complete = () => true;
      const { canvas } = fakeCanvas(gl);
      const mount = form(testInit()) as Mount;
      const h = harness(mount, () => canvas, log, { meter: true });
      warm(h);
      expect(readbacks(log)).toBeGreaterThan(0);
    }
  });
});

describe("a raw kind", () => {
  function rawKind(opts: { returnCanvas: boolean; meter?: boolean }) {
    const log: string[] = [];
    const { gl } = fakeGl(log);
    const { canvas } = fakeCanvas(gl);
    const mount = rawForm({
      setup: () => (opts.returnCanvas ? canvas : undefined),
      frame: () => {},
    })(testInit());
    const h = harness(mount, () => canvas, log, { meter: opts.meter ?? true });
    return { h, canvas };
  }

  it("is metered through the canvas setup returns", () => {
    const { h } = rawKind({ returnCanvas: true });
    warm(h);
    expect(readbacks(h.log)).toBeGreaterThan(0);
    expect(h.sent.find((m) => m.type === "ready")).toEqual({ type: "ready", metered: true });
  });

  it("is not metered when setup returns no canvas, and ready says so", () => {
    const { h } = rawKind({ returnCanvas: false });
    warm(h);
    expect(readbacks(h.log)).toBe(0);
    expect(h.sent.find((m) => m.type === "ready")).toEqual({ type: "ready", metered: false });
  });

  it("steps a meter it made only when frame() is called, and is silent when off", () => {
    const { h, canvas } = rawKind({ returnCanvas: false });
    const mine = h.meters.authored(canvas);
    warm(h);
    expect(h.sent.find((m) => m.type === "ready")).toEqual({ type: "ready", metered: true });
    expect(readbacks(h.log)).toBe(0);
    mine.frame();
    expect(readbacks(h.log)).toBe(1);
    h.send({ type: "meter", on: false });
    mine.frame();
    mine.frame();
    expect(readbacks(h.log)).toBe(1);
  });

  it("posts metered once when its first meter comes after ready", () => {
    const { h, canvas } = rawKind({ returnCanvas: false });
    warm(h);
    expect(h.sent.some((m) => m.type === "metered")).toBe(false);
    h.meters.authored(canvas);
    h.meters.authored(canvas);
    expect(h.sent.filter((m) => m.type === "metered")).toEqual([{ type: "metered" }]);
  });

  it("does not post metered when ready already said true", () => {
    const { h, canvas } = rawKind({ returnCanvas: true });
    warm(h);
    h.meters.authored(canvas);
    expect(h.sent.some((m) => m.type === "metered")).toBe(false);
  });
});

describe("the shader form's flow", () => {
  it("advances uFlow by dt times 0.25 plus the level", () => {
    const set: number[] = [];
    const log: string[] = [];
    const { gl, state } = fakeGl(log);
    state.complete = () => true;
    const { canvas } = fakeCanvas(gl);
    const base = gl.getUniformLocation;
    const names = new Map<unknown, string>();
    gl.getUniformLocation = ((_p: unknown, name: string) => {
      const loc = { name };
      names.set(loc, name);
      return loc;
    }) as typeof base;
    gl.uniform1f = ((loc: unknown, v: number) => {
      if (names.get(loc) === "uFlow") set.push(v);
    }) as typeof gl.uniform1f;
    const mount = shaderForm({ source: "void main() {}" })(testInit()) as Mount;
    const h = harness(mount, () => canvas, log);
    warm(h);
    const before = set.length;
    h.tick();
    expect(set.length).toBe(before + 1);
    const step = (0.25 + restSignal().level) / 30;
    expect(set[before] - set[before - 1]).toBeCloseTo(step, 6);
  });
});

describe("a scene's pass names", () => {
  const pass = (name: string) => () => sceneForm({ passes: [{ name, fs: "#version 300 es\n// p" }] });

  it("accepts an identifier", () => {
    expect(pass("blur_2")).not.toThrow();
    expect(pass("_a")).not.toThrow();
  });

  it("refuses a name that is not a GLSL identifier", () => {
    expect(pass("2blur")).toThrow(/not a valid GLSL identifier/);
    expect(pass("my pass")).toThrow(/not a valid GLSL identifier/);
    expect(pass("blur-2")).toThrow(/not a valid GLSL identifier/);
    expect(pass("")).toThrow(/not a valid GLSL identifier/);
  });

  it("refuses main and the gl_ prefix", () => {
    expect(pass("main")).toThrow(/main/);
    expect(pass("gl_blur")).toThrow(/gl_/);
  });
});
