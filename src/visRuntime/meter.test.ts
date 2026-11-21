import { describe, expect, it } from "vitest";

import { fakeCanvas } from "./fixtures";
import { READBACK_RING, createStageMeter } from "./meter";
import { CELL_H, CELL_W } from "../components/player/visualizers/flash/cellMeter";

import type { MeterEnv } from "./meter";
import type { FlashReading } from "./protocol";

const SIGNALED = 0x911a;
const PENDING = 0x911b;

/**
 * A WebGL2 context for the meter. Each readback lands as the `shade` the test has set when the pixel buffer
 * is read; fences stay pending until `settle` is true.
 */
function fakeMeterGl(antialias = false) {
  const state = { settle: true, shade: 0, blits: 0, reads: 0, deleted: 0 };
  const sizes = new Map<unknown, number>();
  let pack: unknown = null;
  const gl = {
    READ_FRAMEBUFFER: 1,
    DRAW_FRAMEBUFFER: 2,
    PIXEL_PACK_BUFFER: 3,
    RENDERBUFFER: 4,
    READ_FRAMEBUFFER_BINDING: 11,
    DRAW_FRAMEBUFFER_BINDING: 12,
    PIXEL_PACK_BUFFER_BINDING: 13,
    RENDERBUFFER_BINDING: 14,
    ALREADY_SIGNALED: SIGNALED,
    CONDITION_SATISFIED: 0x911c,
    drawingBufferWidth: 1920,
    drawingBufferHeight: 1080,
    getContextAttributes: () => ({ antialias }),
    getParameter: () => null,
    isContextLost: () => false,
    createFramebuffer: () => ({}),
    createRenderbuffer: () => ({}),
    createBuffer: () => ({}),
    bindFramebuffer: () => {},
    bindRenderbuffer: () => {},
    renderbufferStorage: () => {},
    framebufferRenderbuffer: () => {},
    bindBuffer: (_t: number, b: unknown) => {
      pack = b;
    },
    bufferData: (_t: number, size: number) => {
      sizes.set(pack, size);
    },
    blitFramebuffer: () => {
      state.blits++;
    },
    readPixels: () => {
      state.reads++;
    },
    fenceSync: () => ({}),
    flush: () => {},
    clientWaitSync: () => (state.settle ? SIGNALED : PENDING),
    getBufferSubData: (_t: number, _o: number, dst: Uint8Array) => {
      for (let i = 0; i < dst.length; i += 4) dst.set([state.shade, state.shade, state.shade, 255], i);
    },
    deleteSync: () => {},
    deleteBuffer: () => {
      state.deleted++;
    },
    deleteFramebuffer: () => {},
    deleteRenderbuffer: () => {},
  };
  return { gl: gl as unknown as WebGL2RenderingContext, state };
}

function setup(gl: WebGL2RenderingContext) {
  const reports: FlashReading[] = [];
  let at = 0;
  const env: MeterEnv = {
    now: () => at,
    scratch: () => {
      throw new Error("no scratch canvas expected");
    },
  };
  const { canvas } = fakeCanvas(gl);
  const meter = createStageMeter(canvas, (r) => reports.push(r), env);
  return {
    reports,
    meter,
    // One drawn frame `ms` after the last.
    step(ms: number) {
      at += ms;
      meter.frame();
    },
  };
}

describe("the stage meter", () => {
  it("takes at most one reading per drawn frame, aiming at 20 Hz", () => {
    const { gl, state } = fakeMeterGl();
    const run = setup(gl);
    for (let i = 0; i < 60; i++) run.step(1000 / 60);
    expect(state.blits).toBeGreaterThanOrEqual(19);
    expect(state.blits).toBeLessThanOrEqual(21);
    expect(state.blits).toBe(state.reads);
  });

  it("reports a stage that flashes, once", () => {
    const { gl, state } = fakeMeterGl();
    const run = setup(gl);
    for (let i = 0; i < 120; i++) {
      state.shade = Math.floor(i / 2) % 2 === 0 ? 40 : 200;
      run.step(50);
    }
    expect(run.reports).toHaveLength(1);
    expect(run.reports[0].flashesPerSec).toBeGreaterThan(3);
  });

  it("reports nothing for a steady stage", () => {
    const { gl, state } = fakeMeterGl();
    const run = setup(gl);
    state.shade = 100;
    for (let i = 0; i < 120; i++) run.step(50);
    expect(run.reports).toHaveLength(0);
  });

  it("skips a step when all readings are still pending, and never reads the gap as a flash", () => {
    const { gl, state } = fakeMeterGl();
    const run = setup(gl);
    state.settle = false;
    for (let i = 0; i < 10; i++) run.step(50);
    expect(state.reads).toBe(READBACK_RING);
    // A stage that alternates on every reading would flash at 10 a second had the skipped steps counted.
    state.settle = true;
    for (let i = 0; i < 60; i++) {
      state.shade = i % 2 === 0 ? 40 : 200;
      run.step(500);
    }
    expect(run.reports).toHaveLength(0);
  });

  it("starts a fresh series after a long silence between frames", () => {
    const { gl, state } = fakeMeterGl();
    const run = setup(gl);
    for (let i = 0; i < 60; i++) {
      state.shade = i % 2 === 0 ? 40 : 200;
      run.step(400);
    }
    expect(run.reports).toHaveLength(0);
  });

  it("falls back to a small 2D canvas when the context is multisampled", () => {
    const { gl, state } = fakeMeterGl(true);
    const draws: number[][] = [];
    const reports: FlashReading[] = [];
    let at = 0;
    const ctx = {
      drawImage: (_c: unknown, _x: number, _y: number, w: number, h: number) => draws.push([w, h]),
      getImageData: () => ({ data: new Uint8ClampedArray(CELL_W * CELL_H * 4) }),
    };
    const env: MeterEnv = { now: () => at, scratch: () => ctx as unknown as CanvasRenderingContext2D };
    const { canvas } = fakeCanvas(gl);
    canvas.width = 100;
    canvas.height = 50;
    const meter = createStageMeter(canvas, (r) => reports.push(r), env);
    for (let i = 0; i < 10; i++) {
      at += 50;
      meter.frame();
    }
    expect(draws[0]).toEqual([CELL_W, CELL_H]);
    expect(state.blits).toBe(0);
  });

  it("releases its buffers on dispose", () => {
    const { gl, state } = fakeMeterGl();
    const run = setup(gl);
    run.step(50);
    run.meter.dispose();
    expect(state.deleted).toBe(READBACK_RING);
  });
});
