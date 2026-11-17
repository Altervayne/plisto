/*
 * P7b: ends the GPU process, up to three times, and records what the page's WebGL does afterwards. It stops
 * at the first outcome that is not a clean restart. What happens when the browser process itself ends
 * cannot be recorded by the page: the host prints each crash to the dev terminal. The acknowledgement
 * tick is enforced by the catalog and the card; this module supplies the warning text and the logic.
 */

// -- Local Imports --
import { probeGpuCrash } from "../ipc";
import { glRendererString } from "../pageEnv";
import { abortable, sleep } from "./p03Process";

// -- Type Imports --
import type { ProbeModule, ProbeOutcome } from "../types";

export const WARNING =
  "Crashes Plisto's GPU process up to three times. Worst case: every Plisto window goes blank or closes (the browser process ends), or drawing falls back to software for the rest of this session. Copy results first. If Plisto closes, its next launch, dev or installed (they share the app data folder), may ask 'Plisto closed unexpectedly': choose Start normally.";

export const MAX_CRASHES = 3;
// What `glRendererString` returns when the page cannot create a WebGL2 context.
const UNAVAILABLE = "unavailable";
const SETTLE_MS = 5_000;
const WATCHED_CONTEXTS = 2;

export type GpuOutcome = "clean-restart" | "renderer-changed" | "webgl-refused" | "not-lost" | "not-restored";

export interface GpuObservation {
  /** Whether a fresh WebGL2 context could be created after the wait. */
  webglAvailable: boolean;
  rendererBefore: string;
  rendererAfter: string;
  /** Watched contexts that fired a loss and a restore event. */
  lost: number;
  restored: number;
}

/** Names what one GPU process end did, from what the page saw. */
export function classifyGpuOutcome(o: GpuObservation): GpuOutcome {
  if (!o.webglAvailable) return "webgl-refused";
  if (o.rendererAfter !== o.rendererBefore) return "renderer-changed";
  if (o.lost === 0) return "not-lost";
  if (o.restored < o.lost) return "not-restored";
  return "clean-restart";
}

/** Only a clean restart lets the run go on to another crash. */
export function continuesAfter(outcome: GpuOutcome): boolean {
  return outcome === "clean-restart";
}

export interface ContextWatch {
  /** How many contexts were created. */
  readonly created: number;
  counts(): { lost: number; restored: number };
  dispose(): void;
}

/** Creates WebGL2 contexts in the page and counts their loss and restore events. */
export function watchContexts(n: number): ContextWatch {
  let lost = 0;
  let restored = 0;
  const canvases: HTMLCanvasElement[] = [];
  for (let i = 0; i < n; i++) {
    const canvas = document.createElement("canvas");
    if (!canvas.getContext("webgl2")) continue;
    canvas.addEventListener("webglcontextlost", (e) => {
      e.preventDefault();
      lost += 1;
    });
    canvas.addEventListener("webglcontextrestored", () => {
      restored += 1;
    });
    canvases.push(canvas);
  }
  return {
    created: canvases.length,
    counts: () => ({ lost, restored }),
    dispose() {
      for (const c of canvases) c.getContext("webgl2")?.getExtension("WEBGL_lose_context")?.loseContext();
      canvases.length = 0;
    },
  };
}

async function run(ctx: Parameters<ProbeModule["run"]>[0]): Promise<ProbeOutcome> {
  const lines: string[] = [];
  for (let n = 1; n <= MAX_CRASHES; n++) {
    const watch = watchContexts(WATCHED_CONTEXTS);
    const rendererBefore = glRendererString();
    if (rendererBefore === UNAVAILABLE) {
      watch.dispose();
      lines.push(`crash ${n}: not done, the page has no WebGL2 context to compare against`);
      return { state: n === 1 ? "invalid" : "measured", lines };
    }
    ctx.log(`crash ${n} of ${MAX_CRASHES}`);
    let pid: number;
    try {
      pid = await abortable(probeGpuCrash(), ctx.signal);
    } catch (e) {
      watch.dispose();
      if (ctx.signal.aborted) throw e;
      lines.push(`crash ${n}: not done (${e instanceof Error ? e.message : String(e)})`);
      return { state: n === 1 ? "invalid" : "measured", lines };
    }
    await sleep(SETTLE_MS, ctx.signal).catch((e) => {
      watch.dispose();
      throw e;
    });
    const rendererAfter = glRendererString();
    const { lost, restored } = watch.counts();
    watch.dispose();
    const outcome = classifyGpuOutcome({
      webglAvailable: rendererAfter !== UNAVAILABLE,
      rendererBefore,
      rendererAfter,
      lost,
      restored,
    });
    lines.push(
      `crash ${n}: pid ${pid}; contexts lost ${lost}/${watch.created}, restored ${restored}/${watch.created}; renderer "${rendererBefore}" then "${rendererAfter}"; ${outcome}`,
    );
    if (!continuesAfter(outcome)) {
      lines.push(`stopped after crash ${n}: ${outcome}`);
      break;
    }
  }
  lines.push("a browser-process end cannot be recorded here: see the dev terminal for the [probe] gpu crash lines");
  return { state: "measured", lines };
}

export const probe: ProbeModule = { id: "P7b", run, warning: WARNING, timeoutMs: 60_000 };
