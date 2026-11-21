/*
 * The waveform window feed: the engine's 256-value `player:wave` emit, held as the latest window. The emit
 * costs the engine a snapshot per frame, so it runs only while at least one mount that draws the waveform
 * is showing; the holders are counted across mounts.
 */

// -- Library Imports --
import { listen } from "@tauri-apps/api/event";

// -- IPC Imports --
import { playerSetWaveform } from "../../../lib/ipc";

/** The effects the hub needs, injected so a test runs without the engine. */
export interface WaveDeps {
  setEmit: (on: boolean) => Promise<void>;
  // Starts delivering windows to the handler and returns the stop.
  follow: (handler: (window: number[]) => void) => () => void;
}

export interface WaveHub {
  // Counts one holder; the emit turns on with the first. The release is idempotent.
  acquire: () => () => void;
  // The latest window, or null before one lands since the emit was last switched on.
  latest: () => Float32Array | null;
  holders: () => number;
}

export function createWaveHub(deps: WaveDeps): WaveHub {
  let holders = 0;
  let latest: Float32Array | null = null;
  let stop: (() => void) | null = null;
  return {
    acquire() {
      holders += 1;
      if (holders === 1) {
        stop = deps.follow((window) => {
          latest = Float32Array.from(window);
        });
        void deps.setEmit(true).catch(() => {});
      }
      let released = false;
      return () => {
        if (released) return;
        released = true;
        holders -= 1;
        if (holders > 0) return;
        stop?.();
        stop = null;
        latest = null;
        void deps.setEmit(false).catch(() => {});
      };
    },
    latest: () => latest,
    holders: () => holders,
  };
}

/** Follows the engine event; the stop tears the listener down even when it lands mid-subscribe. */
function followWave(handler: (window: number[]) => void): () => void {
  let alive = true;
  let unlisten: (() => void) | null = null;
  void listen<number[]>("player:wave", (e) => handler(e.payload))
    .then((fn) => {
      if (alive) unlisten = fn;
      else fn();
    })
    .catch(() => {});
  return () => {
    alive = false;
    unlisten?.();
  };
}

/** The app's one hub, over the engine. */
export const waveHub: WaveHub = createWaveHub({ setEmit: playerSetWaveform, follow: followWave });
