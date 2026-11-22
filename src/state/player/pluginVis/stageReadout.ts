/*
 * The developer-mode stage readout's numbers for one kind on one surface: acks per second over a sliding
 * second, the frame's own cost from its latest ack, ticks in flight and the flash meter's state, read from
 * the shown stage handle. The sampler follows the shown handle, so a kind switch or a remount re-bases it.
 * The hook runs it only while the readout is mounted and sets state only when a shown value changed.
 */

// -- Framework Imports --
import { useEffect, useState } from "react";

// -- State Imports --
import { isShownStage, stageHandles, type StageHandle, type StageSurface } from "./frameCache";

/** How often the readout samples. */
export const READOUT_SAMPLE_MS = 250;
/** The window the frame rate is read over. */
export const READOUT_FPS_WINDOW_MS = 1000;

export type MeterReading = "on" | "unwatched" | "unknown";

export interface StageReadout {
  // Acks per second, whole; null until two samples span time.
  fps: number | null;
  // The frame's cost from its latest ack, one decimal; null before any ack.
  frameMs: string | null;
  inFlight: number | null;
  meter: MeterReading;
}

export const EMPTY_READOUT: StageReadout = {
  fps: null,
  frameMs: null,
  inFlight: null,
  meter: "unknown",
};

export interface ReadoutDeps {
  now: () => number;
  handles: () => readonly StageHandle[];
}

const productionDeps: ReadoutDeps = {
  now: () => performance.now(),
  handles: stageHandles,
};

const meterOf = (metered: boolean | null): MeterReading =>
  metered === null ? "unknown" : metered ? "on" : "unwatched";

/** Whether two readings show the same thing. */
export function sameReadout(a: StageReadout, b: StageReadout): boolean {
  return a.fps === b.fps && a.frameMs === b.frameMs && a.inFlight === b.inFlight && a.meter === b.meter;
}

/** A sampler for the kind's shown handle on a surface. Each call reads once and returns the reading. */
export function createReadoutSampler(
  kind: string,
  surface: StageSurface,
  deps: ReadoutDeps = productionDeps,
) {
  let followed: StageHandle | null = null;
  let samples: { at: number; acked: number }[] = [];

  return (): StageReadout => {
    const handle = deps.handles().find((h) => h.kind === kind && h.surface === surface && isShownStage(h));
    if (handle !== followed) {
      followed = handle ?? null;
      samples = [];
    }
    const stats = handle?.stats() ?? null;
    if (!handle || !stats) return EMPTY_READOUT;
    const at = deps.now();
    // A counter that went backwards is a new frame under the same handle.
    if (samples.length > 0 && stats.acked < samples[samples.length - 1].acked) samples = [];
    samples.push({ at, acked: stats.acked });
    while (samples.length > 2 && at - samples[1].at >= READOUT_FPS_WINDOW_MS) samples.shift();
    const first = samples[0];
    const span = at - first.at;
    return {
      fps: span > 0 ? Math.round(((stats.acked - first.acked) * 1000) / span) : null,
      frameMs: stats.lastAckMs === null ? null : stats.lastAckMs.toFixed(1),
      inFlight: stats.outstanding,
      meter: meterOf(handle.metered()),
    };
  };
}

/**
 * Starts sampling and reports each changed reading, until the returned stop runs. The first reading is
 * taken at once.
 */
export function startReadout(
  kind: string,
  surface: StageSurface,
  onReading: (reading: StageReadout) => void,
  deps: ReadoutDeps = productionDeps,
): () => void {
  const sample = createReadoutSampler(kind, surface, deps);
  const tick = () => onReading(sample());
  tick();
  const timer = setInterval(tick, READOUT_SAMPLE_MS);
  return () => clearInterval(timer);
}

/** The live readout for a kind on a surface, sampled only while `active` and while the caller is mounted. */
export function useStageReadout(kind: string, surface: StageSurface, active: boolean): StageReadout {
  const [reading, setReading] = useState<StageReadout>(EMPTY_READOUT);
  useEffect(() => {
    if (!active) return;
    return startReadout(kind, surface, (next) =>
      setReading((prev) => (sameReadout(prev, next) ? prev : next)),
    );
  }, [kind, surface, active]);
  return reading;
}
