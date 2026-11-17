/*
 * P7a: a visualizer frame loses its own WebGL context on purpose. Two WebGL2 contexts of the main
 * document watch for a loss event; the GPU process is not touched.
 */

// -- Local Imports --
import { mountFilling, sleep, waitFor } from "./p03Process";
import { watchContexts } from "./p07GpuLoss";

// -- Type Imports --
import type { OutcomeState, ProbeModule, ProbeOutcome } from "../types";

const SETTLE_MS = 500;
const WATCHED_CONTEXTS = 2;

export interface P7aFacts {
  /** Whether the frame's own context fired a loss event. */
  frameLost: boolean;
  watched: number;
  mainLost: number;
}

export function p7aVerdict(f: P7aFacts): { state: OutcomeState; reasons: string[] } {
  if (f.watched < WATCHED_CONTEXTS) return { state: "invalid", reasons: ["the page could not create its watched contexts"] };
  if (!f.frameLost) return { state: "invalid", reasons: ["the frame's own context was not lost, so the loss was not exercised"] };
  if (f.mainLost > 0) return { state: "fail", reasons: [`${f.mainLost} page context(s) fired a loss event`] };
  return { state: "pass", reasons: [] };
}

async function run(ctx: Parameters<ProbeModule["run"]>[0]): Promise<ProbeOutcome> {
  const slot = ctx.stages.subject.slot;
  ctx.stages.subject.setBlend("normal");
  ctx.stages.subject.setDip(1);
  const watch = watchContexts(WATCHED_CONTEXTS);
  const frame = await mountFilling(slot, "probe-vis", "vis-lose.html", ctx.signal).catch((e) => {
    watch.dispose();
    throw e;
  });
  try {
    const result = waitFor(frame.port, "lose-result", 10_000, ctx.signal);
    frame.port.postMessage({ type: "lose" });
    const msg = await result;
    if (msg.refused || msg.noExtension) {
      return { state: "invalid", lines: [`the frame could not lose a context (${msg.refused ? "WebGL2 refused" : "no WEBGL_lose_context"})`] };
    }
    await sleep(SETTLE_MS, ctx.signal);
    const events = Array.isArray(msg.events) ? (msg.events as string[]) : [];
    const { lost, restored } = watch.counts();
    const verdict = p7aVerdict({ frameLost: events.includes("lost"), watched: watch.created, mainLost: lost });
    const lines = [
      `frame: events ${events.join(", ") || "none"}; lost after lose ${String(msg.lostAfterLose)}; lost after restore ${String(msg.lostAfterRestore)}`,
      `page: ${watch.created} contexts watched, loss events ${lost}, restore events ${restored}`,
    ];
    if (verdict.reasons.length > 0) lines.push(`reasons: ${verdict.reasons.join("; ")}`);
    return { state: verdict.state, lines };
  } finally {
    frame.unmount();
    watch.dispose();
  }
}

export const probe: ProbeModule = { id: "P7a", run, timeoutMs: 30_000 };
