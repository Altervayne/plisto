/*
 * Stand-ins the runtime's tests share: a GL context the real renderer runs on, a canvas, an init, ticks,
 * and a harness that mounts a kind on a frame whose animation frames never come, so only ticks drive it.
 */

// -- Local Imports --
import { startMount } from "./lifecycle";
import { createMeterHub } from "./meterHub";
import { restSignal } from "../state/player/visualSignal";
import { FS_VS } from "../components/player/visualizers/gl/shaders";
import { createRenderer } from "../components/player/visualizers/gl/renderer";

// -- Type Imports --
import type { VisFrame } from "./frame";
import type { LifecycleEnv, Mount, VisPort } from "./lifecycle";
import type { FrameMessage, Tick, VisInit } from "./protocol";
import type { Candidate, Kit } from "../components/player/visualizers/gl/kit";

const COMPLETION = 0x91b1;
const LINK_STATUS = 4;

export interface FakeProgram {
  srcs: string[];
}

/**
 * A GL context for the whole renderer. It logs `draw` for every draw call and `shown` for one into the
 * canvas's own framebuffer, logs every status query, and lets a test say which programs have finished
 * compiling. Without `parallel`, the parallel-compile extension is missing.
 */
export function fakeGl(log: string[], parallel = true) {
  const state = {
    complete: (_p: FakeProgram) => false,
    linkOk: true,
  };
  let bound: unknown = null;
  const ext = { COMPLETION_STATUS_KHR: COMPLETION };
  const gl = new Proxy(
    {
      COMPILE_STATUS: 3,
      LINK_STATUS,
      getExtension: (n: string) => (n === "KHR_parallel_shader_compile" && parallel ? ext : null),
      isContextLost: () => false,
      createShader: () => ({ src: "" }),
      shaderSource: (s: { src: string }, src: string) => {
        s.src = src;
      },
      createProgram: (): FakeProgram => ({ srcs: [] }),
      attachShader: (p: FakeProgram, s: { src: string }) => p.srcs.push(s.src),
      getShaderParameter: () => {
        log.push("status:shader");
        return true;
      },
      getProgramParameter: (p: FakeProgram, k: number) => {
        if (k === COMPLETION) return state.complete(p);
        log.push("status:link");
        return state.linkOk;
      },
      getProgramInfoLog: () => "link failed here",
      getShaderInfoLog: () => "shader log",
      getUniformLocation: () => ({}),
      bindFramebuffer: (_t: unknown, fbo: unknown) => {
        bound = fbo;
      },
      readPixels: () => {
        log.push("readback");
      },
      drawArrays: () => {
        log.push(bound === null ? "shown" : "draw");
      },
    } as Record<string, unknown>,
    {
      get(target, key: string) {
        if (key in target) return target[key];
        return (...args: unknown[]) => (key.startsWith("create") ? { key, args } : undefined);
      },
    },
  ) as unknown as WebGL2RenderingContext;
  return { gl, state };
}

/** A canvas over `gl`. Removing it takes it out of `stage`, the canvases in the page. */
export function fakeCanvas(gl: WebGL2RenderingContext, stage: unknown[] = []) {
  const listeners: Record<string, (e: unknown) => void> = {};
  const canvas = {
    width: 0,
    height: 0,
    style: {},
    getContext: () => gl,
    addEventListener: (type: string, fn: (e: unknown) => void) => {
      listeners[type] = fn;
    },
    removeEventListener: (type: string, fn: (e: unknown) => void) => {
      if (listeners[type] === fn) delete listeners[type];
    },
    remove: () => {
      const at = stage.indexOf(canvas);
      if (at >= 0) stage.splice(at, 1);
    },
  };
  return { canvas: canvas as unknown as HTMLCanvasElement, listeners };
}

export function testInit(): VisInit {
  return {
    plisto: 1,
    type: "plisto:vis-init",
    api: 1,
    kind: "test.kind",
    composite: { light: "ink", dark: "light" },
    fillsStage: true,
    needs: { fine: false, cover: false, pointer: false, waveform: false },
    settingShapes: [],
    meter: false,
    context: {
      layout: { width: 100, height: 80, cover: [10, 10, 40, 40], radius: 8, mask: null, floor: null, hush: [] },
      palette: new Float32Array(9),
      cover: null,
      colors: { ground: [0, 0, 0], backing: [0, 0, 0], ink: [1, 1, 1] },
      light: false,
      reactivity: "balanced",
      ambient: false,
      reducedMotion: false,
      settings: {},
    },
  };
}

export function testTick(seq: number, nBeats = 0): Tick & { type: "tick" } {
  return {
    type: "tick",
    seq,
    t: seq / 30,
    dt: 1 / 30,
    sig: restSignal(),
    nBeats,
    beatAt: null,
    rawBands: [],
    fine: null,
    playing: true,
    trackSeq: 1,
    progress: null,
    pointer: null,
    wave: null,
  };
}

/** Mounts `mount` on a frame whose animation frames never come, 200 ms of time per tick. */
export function harness(
  mount: Mount,
  canvasFor: () => HTMLCanvasElement,
  log: string[] = [],
  opts: { meter?: boolean } = {},
) {
  const sent: FrameMessage[] = [];
  const transfers: Transferable[][] = [];
  const snapshots: HTMLCanvasElement[] = [];
  let handler: (data: unknown) => void = () => {};
  const timers: (() => void)[] = [];
  let now = 0;
  let closed = 0;
  const port: VisPort = {
    post: (m, transfer = []) => {
      sent.push(m);
      transfers.push(transfer);
      log.push(`post:${m.type}`);
    },
    listen: (h) => {
      handler = h;
    },
    close: () => {
      closed++;
    },
  };
  const env: LifecycleEnv = {
    now: () => now,
    requestFrame: () => 1,
    cancelFrame: () => {},
    setTimer: (cb) => timers.push(cb),
    clearTimer: () => {},
    prepareRoot: () => {},
    createCanvas: canvasFor,
    snapshot: (canvas) => {
      snapshots.push(canvas);
      return Promise.resolve({} as ImageBitmap);
    },
    createRenderer,
  };
  const init = { ...testInit(), meter: opts.meter ?? false };
  const meters = createMeterHub(
    init.meter,
    (reading) => port.post({ type: "flash", reading }),
    {
      now: () => now,
      scratch: () => {
        throw new Error("no 2d canvas");
      },
    },
  );
  const handle = startMount(init, port, mount, env, meters);
  let seq = 0;
  return {
    log,
    sent,
    transfers,
    snapshots,
    handle,
    meters,
    closed: () => closed,
    send: (data: unknown) => handler(data),
    tick(nBeats = 0) {
      now += 200;
      handler(testTick(++seq, nBeats));
    },
    runTimers() {
      for (const cb of timers.splice(0)) cb();
    },
  };
}

export const MINE = { name: "mine", vs: FS_VS, fs: "#version 300 es\n// mine" };
export const FOUND = { name: "found", vs: FS_VS, fs: "#version 300 es\n// found later" };

/** A kind drawing MINE, and FOUND too once `discover.on`; `drawn` collects the frames it finished. */
export function testCandidate(discover: { on: boolean }, opts: { trail?: boolean; drawn?: VisFrame[] } = {}) {
  return (kit: Kit): Candidate => ({
    mode: "glow",
    bloom: 0,
    exposure: 1,
    inkGain: 1,
    trail: opts.trail ? { decay: 0.9, zoom: 1, rot: 0 } : null,
    draw(f) {
      kit.gl.useProgram(kit.program(MINE).handle);
      if (discover.on) kit.gl.useProgram(kit.program(FOUND).handle);
      kit.drawQuad();
      opts.drawn?.push(f as VisFrame);
    },
    dispose: () => {},
  });
}
