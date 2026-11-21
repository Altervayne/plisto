/*
 * Builds one mount's ticks from Plisto's own signal path, the way the built-in visualizers are fed: the
 * signal follower over the engine's spectrum and level frames, the raw bands, and the optional fine
 * spectrum, waveform and pointer a kind asks for. Fine and waveform emits cost the engine, so a mount
 * holds them only while its slot is visible. A beat carries the engine time of the level frame it fired on.
 */

// -- Type Imports --
import type { LevelFrame, PlayerStatus } from "../../../types";
import type { Tick, VisPointer } from "../../../visRuntime/protocol";
import type { PluginVisualizerNeeds } from "../../plugins/visualizerDecl";
import type { Reactivity } from "../visualizerKind";

// -- State Imports --
import { createSignalFollower } from "../visualSignal";
import { acquireFineSpectrum, getLatestFineSpectrum, getLatestLevel, getLatestSpectrum } from "../spectrum";
import { smoothBands } from "../smoothBands";
import { usePlayerStore } from "../store";
import { waveHub, type WaveHub } from "./waveform";

// The fine spectrum's ballistics, matching the built-in visualizers'.
const FINE_ATTACK = 0.5;
const FINE_DECAY = 0.15;
// The follower's per-frame step is capped as the built-ins' is; the tick's own `dt` is the real gap.
const MAX_STEP_SECS = 0.05;
const FIRST_STEP_SECS = 1 / 60;

/** Where the feed reads from; the defaults are the app's singletons. */
export interface FeedSources {
  bands: () => number[];
  level: () => LevelFrame;
  fine: () => number[] | null;
  status: () => Pick<PlayerStatus, "playing" | "track_id" | "start_seq" | "position_secs" | "duration_secs">;
  pointer: () => VisPointer | null;
  acquireFine: () => () => void;
  waves: WaveHub;
}

export const liveSources: FeedSources = {
  bands: getLatestSpectrum,
  level: getLatestLevel,
  fine: getLatestFineSpectrum,
  status: () => usePlayerStore.getState().status,
  pointer: () => null,
  acquireFine: acquireFineSpectrum,
  waves: waveHub,
};

export interface FeedOptions {
  needs: PluginVisualizerNeeds;
  reactivity: () => Reactivity;
  sources?: FeedSources;
}

export interface Feed {
  // One display frame at `nowMs`: advances the follower and returns the tick.
  step: (nowMs: number) => Tick;
  // Holds the fine and waveform emits only while the slot is visible and the kind needs them.
  setVisible: (visible: boolean) => void;
  dispose: () => void;
}

function progressOf(status: Pick<PlayerStatus, "position_secs" | "duration_secs">): number | null {
  if (status.duration_secs <= 0) return null;
  return Math.min(1, Math.max(0, status.position_secs / status.duration_secs));
}

export function createFeed(options: FeedOptions): Feed {
  const { needs, reactivity } = options;
  const src = options.sources ?? liveSources;
  const follower = createSignalFollower();
  let seq = 0;
  let last: number | null = null;
  let fine: number[] | null = null;
  let trackSeq = 0;
  let trackKey: string | null = null;
  let beatAt: number | null = null;
  let releaseFine: (() => void) | null = null;
  let releaseWave: (() => void) | null = null;

  const setVisible = (visible: boolean) => {
    if (visible && needs.fine && !releaseFine) releaseFine = src.acquireFine();
    if (visible && needs.waveform && !releaseWave) releaseWave = src.waves.acquire();
    if (visible) return;
    releaseFine?.();
    releaseFine = null;
    releaseWave?.();
    releaseWave = null;
    fine = null;
  };

  return {
    step(nowMs) {
      const dt = last === null ? FIRST_STEP_SECS : Math.max(0, (nowMs - last) / 1000);
      last = nowMs;
      const status = src.status();
      // A new item starting, even the same track again, bumps the sequence.
      const key = `${status.track_id}:${status.start_seq}`;
      if (key !== trackKey) {
        if (trackKey !== null) trackSeq += 1;
        trackKey = key;
      }
      const bands = src.bands();
      const level = src.level();
      const live = follower.step(Math.min(MAX_STEP_SECS, dt), {
        bands,
        level,
        playing: status.playing,
        reactivity: reactivity(),
      });
      // The follower mutates one signal in place; a tick keeps its own copy.
      const sig = { ...live, bands: live.bands.slice() };
      const fired = sig.beat > 0;
      if (fired) beatAt = level.at ?? null;
      const rawFine = needs.fine && releaseFine ? src.fine() : null;
      fine = rawFine ? smoothBands(fine ?? [], rawFine, FINE_ATTACK, FINE_DECAY) : null;
      return {
        seq: ++seq,
        t: nowMs / 1000,
        dt,
        sig,
        nBeats: fired ? 1 : 0,
        beatAt,
        rawBands: bands,
        fine,
        playing: status.playing,
        trackSeq,
        progress: progressOf(status),
        pointer: needs.pointer ? src.pointer() : null,
        wave: needs.waveform && releaseWave ? src.waves.latest() : null,
      };
    },
    setVisible,
    dispose: () => setVisible(false),
  };
}
