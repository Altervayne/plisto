/*
 * Runs the stand-in meter in a visualizer frame at 1920 x 1080 and 3840 x 2160 backing sizes. The frame
 * times batches of meter steps inside one animation frame and returns the batch times; the page divides
 * by the batch size and reads the median and p99 of the per-step means.
 */

// -- Local Imports --
import { mountProbeFrame } from "../frames";
import { watchSlot } from "../slotWatch";
import { fixed, maxOf, median, percentile, perItemMs } from "../stats";
import { awaitMessage } from "./transportStandIn";

// -- Type Imports --
import type { ProbeContext, ProbeModule, ProbeOutcome } from "../types";

const FRAMES = 600;
const BATCH = 10;
const MAX_MEDIAN_MS = 0.3;
const RUN_TIMEOUT_MS = 30_000;
const SIZES = [
  { width: 1920, height: 1080, label: "1920 x 1080 (dpr 1)" },
  { width: 3840, height: 2160, label: "3840 x 2160 (dpr 2)" },
];

interface MeterResult {
  error?: string;
  batchMs: number[];
  batch: number;
  step: number;
  steps: number;
  skipped: number;
  completed: number;
  renderer: string;
}

/** Share of steps whose readback may be skipped before the reading stops being a meter step. */
export const MAX_SKIPPED_SHARE = 0.5;

export interface MeterReading {
  /** Per-step means the median was taken from. */
  samples: number;
  median: number;
  steps: number;
  skipped: number;
}

/**
 * Invalid when a size gave no reading or no samples, or when more than half its steps skipped the
 * readback; else fail if any median is at or over the limit, else pass.
 */
export function judgeMeter(readings: readonly MeterReading[], sizes: number): "pass" | "fail" | "invalid" {
  if (readings.length < sizes) return "invalid";
  if (readings.some((r) => r.samples === 0 || r.steps === 0 || r.skipped > r.steps * MAX_SKIPPED_SHARE)) return "invalid";
  return readings.some((r) => r.median >= MAX_MEDIAN_MS) ? "fail" : "pass";
}

function runFrame(port: MessagePort, width: number, height: number, signal: AbortSignal): Promise<MeterResult | null> {
  return awaitMessage<MeterResult & { type: string }>(port, "result", RUN_TIMEOUT_MS, signal, () =>
    port.postMessage({ type: "run", width, height, frames: FRAMES, batch: BATCH }),
  );
}

async function run(ctx: ProbeContext): Promise<ProbeOutcome> {
  const lines: string[] = [];
  const readings: MeterReading[] = [];
  const problems: string[] = [];
  const watch = watchSlot(ctx.stages.subject.slot);
  try {
    for (const size of SIZES) {
      if (ctx.signal.aborted) break;
      ctx.log(size.label);
      const frame = await mountProbeFrame({
        host: "probe-vis",
        file: "vis-meter.html",
        parent: ctx.stages.subject.slot,
        signal: ctx.signal,
        width: "100%",
        height: "100%",
        borderless: true,
      });
      let result: MeterResult | null;
      try {
        result = await runFrame(frame.port, size.width, size.height, ctx.signal);
      } finally {
        frame.unmount();
      }
      if (!result) {
        problems.push(`${size.label}: no result in ${RUN_TIMEOUT_MS} ms`);
        continue;
      }
      if (result.error || result.batchMs.length === 0) {
        problems.push(`${size.label}: ${result.error ?? "no batches timed"}`);
        continue;
      }
      const perStep = perItemMs(result.batchMs, result.batch);
      const med = median(perStep);
      readings.push({ samples: perStep.length, median: med, steps: result.steps, skipped: result.skipped });
      lines.push(
        `${size.label}: median ${fixed(med, 4)} ms per step, p99 of batch means ${fixed(percentile(perStep, 99), 4)} ms, max ${fixed(maxOf(perStep), 4)} ms; ${perStep.length} batches of ${result.batch}; clock step observed in the frame ${fixed(result.step, 4)} ms; readbacks completed ${result.completed} of ${result.steps} steps, ${result.skipped} skipped for a full ring (invalid above ${MAX_SKIPPED_SHARE * 100}% skipped); gl "${result.renderer}"`,
      );
    }
  } finally {
    watch.stop();
  }
  if (ctx.signal.aborted) return { state: "invalid", lines: ["stopped", ...lines] };
  if (watch.leftView) return { state: "invalid", lines: [watch.note, ...lines] };
  return { state: judgeMeter(readings, SIZES.length), lines: [...problems, ...lines] };
}

export const probe: ProbeModule = {
  id: "P12",
  run,
  timeoutMs: 90_000,
};
