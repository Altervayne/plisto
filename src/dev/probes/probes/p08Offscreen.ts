/*
 * Two readings on the offscreen-canvas fallbacks: whether a canvas in the page can hand its control to a
 * cross-origin frame that draws into it, and whether the placeholder can then be read back; and what a
 * 1920 x 1080 ImageBitmap stream from the frame to the page costs per frame.
 */

// -- Local Imports --
import { mountProbeFrame } from "../frames";
import { watchSlot } from "../slotWatch";
import { clockStep, fixed } from "../stats";
import { awaitMessage, waitMs } from "./transportStandIn";

// -- Type Imports --
import type { ProbeContext, ProbeModule, ProbeOutcome } from "../types";

const CANVAS_W = 256;
const CANVAS_H = 256;
const STREAM_W = 1920;
const STREAM_H = 1080;
const STREAM_MS = 5000;
const DRAW_WAIT_MS = 3000;
const SETTLE_MS = 500;

function describe(e: unknown): string {
  return e instanceof Error ? `${e.name}: ${e.message}` : String(e);
}

interface Drawn {
  type: string;
  ok: boolean;
  error: string;
  offscreenType: string;
  arrived: string;
}

/** Hands a canvas's control to the frame and reads what happened, on both sides. */
async function transferReading(port: MessagePort, slot: HTMLElement, signal: AbortSignal): Promise<string[]> {
  const canvas = document.createElement("canvas");
  canvas.width = CANVAS_W;
  canvas.height = CANVAS_H;
  canvas.style.width = "100%";
  canvas.style.height = "100%";
  slot.appendChild(canvas);
  try {
    let off: OffscreenCanvas;
    try {
      off = canvas.transferControlToOffscreen();
    } catch (e) {
      return [`transferControlToOffscreen refused: ${describe(e)}`];
    }
    let postError = "";
    const drawn = await awaitMessage<Drawn>(port, "drawn", DRAW_WAIT_MS, signal, () => {
      try {
        port.postMessage({ type: "canvas", canvas: off }, [off]);
      } catch (e) {
        postError = describe(e);
        throw e;
      }
    });
    if (postError) return [`posting the transferred canvas to the frame failed: ${postError}`];
    if (!drawn) return [`transfer posted; the frame did not answer within ${DRAW_WAIT_MS} ms`];
    const lines = [
      `frame received ${drawn.arrived} (OffscreenCanvas in frame: ${drawn.offscreenType}); drawing ${drawn.ok ? "ran" : `failed: ${drawn.error}`}`,
    ];
    await waitMs(SETTLE_MS, signal);
    lines.push(readPlaceholder(canvas));
    return lines;
  } finally {
    canvas.remove();
  }
}

/** Copies the placeholder into a 2D canvas and reads a pixel back. */
function readPlaceholder(placeholder: HTMLCanvasElement): string {
  const copy = document.createElement("canvas");
  copy.width = CANVAS_W;
  copy.height = CANVAS_H;
  const ctx = copy.getContext("2d");
  if (!ctx) return "placeholder read: no 2D context for the copy";
  try {
    ctx.drawImage(placeholder, 0, 0);
  } catch (e) {
    return `placeholder drawImage threw: ${describe(e)}`;
  }
  try {
    const left = ctx.getImageData(CANVAS_W / 4, CANVAS_H / 2, 1, 1).data;
    const right = ctx.getImageData((CANVAS_W * 3) / 4, CANVAS_H / 2, 1, 1).data;
    const blank = left.every((v) => v === 0) && right.every((v) => v === 0);
    return `placeholder readable${blank ? ", all zero" : ""}: left pixel rgba(${left.join(",")}), right pixel rgba(${right.join(",")})`;
  } catch (e) {
    return `placeholder getImageData threw: ${describe(e)}`;
  }
}

interface StreamReading {
  frames: number;
  fps: number;
  meanHandlerMs: number;
  step: number;
  error: string;
}

/** Receives the frame's bitmaps for `ms`, drawing each and acknowledging it. */
function streamReading(port: MessagePort, ms: number, signal: AbortSignal): Promise<StreamReading> {
  const target = document.createElement("canvas");
  target.width = STREAM_W;
  target.height = STREAM_H;
  const ctx = target.getContext("2d");
  return new Promise((resolve) => {
    let frames = 0;
    let first = 0;
    let last = 0;
    let handlerMs = 0;
    let error = "";
    const readings: number[] = [];
    const finish = () => {
      clearTimeout(timer);
      signal.removeEventListener("abort", finish);
      port.postMessage({ type: "stop" });
      port.onmessage = null;
      const span = last - first;
      resolve({
        frames,
        fps: span > 0 ? ((frames - 1) / span) * 1000 : 0,
        // Summed over every frame, so the clock's rounding averages out of the mean.
        meanHandlerMs: frames > 0 ? handlerMs / frames : 0,
        step: clockStep(readings),
        error,
      });
    };
    const timer = setTimeout(finish, ms);
    signal.addEventListener("abort", finish, { once: true });
    if (signal.aborted) return finish();
    port.onmessage = (e: MessageEvent) => {
      const d = e.data as { type?: string; bmp?: ImageBitmap; error?: string } | null;
      if (d?.type === "stream-error") {
        error = d.error ?? "unknown";
        finish();
        return;
      }
      if (d?.type !== "bitmap" || !d.bmp) return;
      const t0 = performance.now();
      ctx?.drawImage(d.bmp, 0, 0);
      d.bmp.close();
      const t1 = performance.now();
      port.postMessage({ type: "bitmap-ack" });
      handlerMs += t1 - t0;
      readings.push(t0, t1);
      if (frames === 0) first = t1;
      last = t1;
      frames++;
    };
    port.postMessage({ type: "stream" });
  });
}

async function run(ctx: ProbeContext): Promise<ProbeOutcome> {
  const frame = await mountProbeFrame({
    host: "probe-vis",
    file: "vis-offscreen.html",
    parent: ctx.stages.subject.slot,
    signal: ctx.signal,
    width: "100%",
    height: "100%",
    borderless: true,
  });
  try {
    ctx.log("canvas transfer");
    const transfer = await transferReading(frame.port, ctx.stages.subject.slot, ctx.signal);
    ctx.log("bitmap stream");
    const watch = watchSlot(ctx.stages.subject.slot);
    const s = await streamReading(frame.port, STREAM_MS, ctx.signal).finally(() => watch.stop());
    if (ctx.signal.aborted) return { state: "invalid", lines: ["stopped"] };
    if (watch.leftView) return { state: "invalid", lines: [watch.note, ...transfer.map((l) => `canvas: ${l}`)] };
    const lines = [
      ...transfer.map((l) => `canvas: ${l}`),
      s.error
        ? `stream: the frame reported ${s.error}`
        : `stream ${STREAM_W} x ${STREAM_H}: ${s.frames} frames over ${STREAM_MS} ms, ${fixed(s.fps)} fps, page-side ${fixed(s.meanHandlerMs, 2)} ms per frame (drawImage and close), clock step ${fixed(s.step, 3)} ms`,
    ];
    return { state: "measured", lines };
  } finally {
    frame.unmount();
  }
}

export const probe: ProbeModule = {
  id: "P8",
  run,
  timeoutMs: 30_000,
};
