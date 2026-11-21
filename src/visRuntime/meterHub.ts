/*
 * The meters of one mount, switched together by the host's setting. While the setting is off no meter
 * does any work and holds no readback resources: turning it off releases every reader, and the next
 * frame after turning it on builds a fresh one. A stage meter is the runtime's own, on the canvas it
 * draws; an authored one is made by a kind that draws outside its frame handler.
 */

// -- Local Imports --
import { createStageMeter } from "./meter";

// -- Type Imports --
import type { MeterEnv, StageMeter } from "./meter";
import type { FlashReading } from "./protocol";

export interface MeterHub {
  /** Sets whether metering is on; turning it off releases every reader. */
  setOn: (on: boolean) => void;
  /** A meter the runtime steps itself, on the canvas the mount draws. */
  stage: (canvas: HTMLCanvasElement) => StageMeter;
  /** A meter a kind steps itself; the hub is told the first time one is made. */
  authored: (canvas: HTMLCanvasElement) => StageMeter;
  /** Whether a kind has made a meter. */
  hasAuthored: () => boolean;
  /** Calls `cb` when a kind first makes a meter. */
  onAuthored: (cb: () => void) => void;
  dispose: () => void;
}

export function createMeterHub(
  on: boolean,
  report: (reading: FlashReading) => void,
  env: MeterEnv,
): MeterHub {
  let enabled = on;
  let made = false;
  let notify: () => void = () => {};
  const live = new Set<{ release: () => void }>();

  const watch = (canvas: HTMLCanvasElement): StageMeter => {
    let inner: StageMeter | null = null;
    let disposed = false;
    const release = () => {
      inner?.dispose();
      inner = null;
    };
    const entry = { release };
    live.add(entry);
    return {
      frame() {
        if (!enabled || disposed) return;
        inner ??= createStageMeter(canvas, report, env);
        inner.frame();
      },
      dispose() {
        disposed = true;
        release();
        live.delete(entry);
      },
    };
  };

  return {
    setOn(next) {
      enabled = next;
      if (!enabled) for (const entry of live) entry.release();
    },
    stage: watch,
    authored(canvas) {
      const meter = watch(canvas);
      if (!made) {
        made = true;
        notify();
      }
      return meter;
    },
    hasAuthored: () => made,
    onAuthored(cb) {
      notify = cb;
    },
    dispose() {
      for (const entry of live) entry.release();
      live.clear();
    },
  };
}
