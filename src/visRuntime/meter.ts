/*
 * The stage meter: takes the registered canvas down to a 64 x 36 reading a few times a second and feeds the
 * cell flash meter. On a WebGL2 canvas the frame is blitted to a small target and read back into a ring of
 * pixel buffers behind fences, so no step waits on the GPU; any other canvas is drawn onto a small 2D canvas
 * and read from it. A step that cannot be taken, a stalled readback or a long silence between frames is a gap
 * in the series, never a zero. The meter only watches: it never changes what the kind draws.
 */

// -- Local Imports --
import { CELL_H, CELL_HZ, CELL_W, createCellMeter } from "../components/player/visualizers/flash/cellMeter";

// -- Type Imports --
import type { FlashReading } from "./protocol";

/** What a kind holds for its canvas. */
export interface StageMeter {
  /** Call after each frame is drawn, in the task that drew it. Takes a reading when one is due. */
  frame: () => void;
  dispose: () => void;
}

export interface MeterEnv {
  now: () => number;
  // The small 2D canvas readings are drawn onto when the stage cannot be read back asynchronously.
  scratch: () => CanvasRenderingContext2D;
}

// Readings in flight at once; a step that finds them all pending is skipped.
export const READBACK_RING = 3;
const STEP_MS = 1000 / CELL_HZ;
// A frame this soon after the last reading waits for the next one.
const DUE_MS = STEP_MS * 0.9;
// Readings further apart than this are not one series.
const STALE_MS = STEP_MS * 5;
const BYTES = CELL_W * CELL_H * 4;

interface Reader {
  /** Starts a reading; false when none can be started. */
  start: (gapBefore: boolean) => boolean;
  /** Hands over the finished readings, oldest first. */
  harvest: (deliver: (bytes: Uint8Array, gapBefore: boolean) => void) => void;
  dispose: () => void;
}

interface Slot {
  pbo: WebGLBuffer;
  fence: WebGLSync | null;
  gapBefore: boolean;
}

function glReader(gl: WebGL2RenderingContext): Reader {
  const fbo = gl.createFramebuffer();
  const target = gl.createRenderbuffer();
  const ring: Slot[] = [];
  const bytes = new Uint8Array(BYTES);
  let head = 0;
  let tail = 0;

  /** Runs `fn` and puts back the bindings it used, so the kind's own state is untouched. */
  const keeping = <T>(fn: () => T): T => {
    const read = gl.getParameter(gl.READ_FRAMEBUFFER_BINDING);
    const draw = gl.getParameter(gl.DRAW_FRAMEBUFFER_BINDING);
    const pack = gl.getParameter(gl.PIXEL_PACK_BUFFER_BINDING);
    const buffer = gl.getParameter(gl.RENDERBUFFER_BINDING);
    try {
      return fn();
    } finally {
      gl.bindFramebuffer(gl.READ_FRAMEBUFFER, read);
      gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, draw);
      gl.bindBuffer(gl.PIXEL_PACK_BUFFER, pack);
      gl.bindRenderbuffer(gl.RENDERBUFFER, buffer);
    }
  };

  keeping(() => {
    gl.bindRenderbuffer(gl.RENDERBUFFER, target);
    gl.renderbufferStorage(gl.RENDERBUFFER, gl.RGBA8, CELL_W, CELL_H);
    gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, fbo);
    gl.framebufferRenderbuffer(gl.DRAW_FRAMEBUFFER, gl.COLOR_ATTACHMENT0, gl.RENDERBUFFER, target);
    for (let i = 0; i < READBACK_RING; i++) {
      const pbo = gl.createBuffer() as WebGLBuffer;
      gl.bindBuffer(gl.PIXEL_PACK_BUFFER, pbo);
      gl.bufferData(gl.PIXEL_PACK_BUFFER, BYTES, gl.STREAM_READ);
      ring.push({ pbo, fence: null, gapBefore: false });
    }
  });

  return {
    start(gapBefore) {
      const slot = ring[head];
      const w = gl.drawingBufferWidth;
      const h = gl.drawingBufferHeight;
      if (slot.fence || gl.isContextLost() || w === 0 || h === 0) return false;
      keeping(() => {
        gl.bindFramebuffer(gl.READ_FRAMEBUFFER, null);
        gl.bindFramebuffer(gl.DRAW_FRAMEBUFFER, fbo);
        gl.blitFramebuffer(0, 0, w, h, 0, 0, CELL_W, CELL_H, gl.COLOR_BUFFER_BIT, gl.LINEAR);
        gl.bindFramebuffer(gl.READ_FRAMEBUFFER, fbo);
        gl.bindBuffer(gl.PIXEL_PACK_BUFFER, slot.pbo);
        gl.readPixels(0, 0, CELL_W, CELL_H, gl.RGBA, gl.UNSIGNED_BYTE, 0);
      });
      slot.fence = gl.fenceSync(gl.SYNC_GPU_COMMANDS_COMPLETE, 0);
      slot.gapBefore = gapBefore;
      gl.flush();
      head = (head + 1) % READBACK_RING;
      return true;
    },
    harvest(deliver) {
      for (let slot = ring[tail]; slot.fence; slot = ring[tail]) {
        const status = gl.clientWaitSync(slot.fence, 0, 0);
        if (status !== gl.ALREADY_SIGNALED && status !== gl.CONDITION_SATISFIED) break;
        keeping(() => {
          gl.bindBuffer(gl.PIXEL_PACK_BUFFER, slot.pbo);
          gl.getBufferSubData(gl.PIXEL_PACK_BUFFER, 0, bytes);
        });
        gl.deleteSync(slot.fence);
        slot.fence = null;
        tail = (tail + 1) % READBACK_RING;
        deliver(bytes, slot.gapBefore);
      }
    },
    dispose() {
      for (const slot of ring) {
        if (slot.fence) gl.deleteSync(slot.fence);
        gl.deleteBuffer(slot.pbo);
      }
      gl.deleteFramebuffer(fbo);
      gl.deleteRenderbuffer(target);
    },
  };
}

function scratchReader(canvas: HTMLCanvasElement, ctx: CanvasRenderingContext2D): Reader {
  let ready: { bytes: Uint8Array; gapBefore: boolean } | null = null;
  return {
    start(gapBefore) {
      if (ready || canvas.width === 0 || canvas.height === 0) return false;
      ctx.drawImage(canvas, 0, 0, CELL_W, CELL_H);
      const data = ctx.getImageData(0, 0, CELL_W, CELL_H).data;
      ready = { bytes: new Uint8Array(data.buffer, data.byteOffset, data.length), gapBefore };
      return true;
    },
    harvest(deliver) {
      const taken = ready;
      ready = null;
      if (taken) deliver(taken.bytes, taken.gapBefore);
    },
    dispose() {},
  };
}

function readerFor(canvas: HTMLCanvasElement, env: MeterEnv): Reader {
  const gl = canvas.getContext("webgl2") as WebGL2RenderingContext | null;
  // A multisampled frame cannot be blitted to another size.
  if (gl && !gl.getContextAttributes()?.antialias) return glReader(gl);
  return scratchReader(canvas, env.scratch());
}

/**
 * Meters `canvas`. `report` is called once, with the worst reading, when the cell meter trips. A failure
 * inside the meter ends the series and never reaches the kind.
 */
export function createStageMeter(
  canvas: HTMLCanvasElement,
  report: (reading: FlashReading) => void,
  env: MeterEnv,
): StageMeter {
  const cells = createCellMeter();
  let reader: Reader | null = null;
  let lastAt: number | null = null;
  let skipped = false;
  let reported = false;

  const deliver = (bytes: Uint8Array, gapBefore: boolean) => {
    if (gapBefore) cells.gap();
    cells.frame(bytes);
    if (!reported && cells.tripped()) {
      reported = true;
      report({ ...cells.reading() });
    }
  };

  return {
    frame() {
      try {
        const t = env.now();
        reader ??= readerFor(canvas, env);
        reader.harvest(deliver);
        if (lastAt !== null && t - lastAt < DUE_MS) return;
        const stale = lastAt !== null && t - lastAt > STALE_MS;
        if (reader.start(skipped || stale)) {
          lastAt = t;
          skipped = false;
        } else skipped = true;
      } catch {
        cells.gap();
        skipped = true;
      }
    },
    dispose() {
      try {
        reader?.dispose();
      } catch {
        // The context is already gone.
      }
      reader = null;
    },
  };
}

/** The meter's environment on a page: real time, and a scratch canvas made when first needed. */
export function browserMeterEnv(): MeterEnv {
  let ctx: CanvasRenderingContext2D | null = null;
  return {
    now: () => performance.now(),
    scratch() {
      if (!ctx) {
        const scratch = document.createElement("canvas");
        scratch.width = CELL_W;
        scratch.height = CELL_H;
        ctx = scratch.getContext("2d", { willReadFrequently: true }) as CanvasRenderingContext2D;
      }
      return ctx;
    },
  };
}
