/*
 * Real tracks for the lab: replays a dump of the engine's own analysis (the audio module's dump test)
 * through the app's signal follower. Frames are held between engine ticks the way spectrum.ts holds
 * them, and the follower reads each new tick as a new emit, so the signal is what the app feeds a scene.
 * Dumps live in .ai/lab-tracks/ and are served by the dev server; they never ship.
 */

// -- State Imports --
import { createSignalFollower } from "../../state/player/visualSignal";
import { smoothBands } from "../../state/player/spectrum";
import type { Reactivity } from "../../state/player/visualizerKind";

// -- Local Imports --
import { FINE_ATTACK, FINE_DECAY } from "./labMusic";
import type { LabSong } from "./labSong";

// -- Type Imports --
import { BAND_COUNT, FINE_BAND_COUNT, type LevelFrame } from "../../types";

/** One track's dump: a frame per engine tick, one array per field. */
export interface TrackDump {
  sampleRate: number;
  // The engine's tick period; tick i is the frame emitted at (i + 1) * tickMs into the track.
  tickMs: number;
  durationSecs: number;
  ticks: number;
  bands: number[][];
  fine: number[][];
  rms: number[];
  peak: number[];
  flux: number[];
  rmsDb: number[];
}

/** A dump with the name it was loaded under. */
export interface LoadedTrack {
  name: string;
  dump: TrackDump;
}

/** Loads `.ai/lab-tracks/<name>.json` from the dev server. A missing or malformed dump is an error. */
export async function loadTrack(name: string): Promise<LoadedTrack> {
  if (!/^[a-z0-9-]+$/.test(name)) throw new Error(`track= must be a dump name such as 01-dancing-plague, got "${name}"`);
  const res = await fetch(`/.ai/lab-tracks/${name}.json`);
  const missing = `no dump named "${name}" in .ai/lab-tracks/; run the audio dump test to write it`;
  if (!res.ok) throw new Error(missing);
  let dump: TrackDump;
  try {
    dump = (await res.json()) as TrackDump;
  } catch {
    throw new Error(missing);
  }
  const shaped =
    dump.ticks > 0 &&
    dump.bands?.length === dump.ticks &&
    dump.fine?.length === dump.ticks &&
    dump.bands[0].length === BAND_COUNT &&
    dump.fine[0].length === FINE_BAND_COUNT;
  if (!shaped) throw new Error(`the dump "${name}" does not hold ${BAND_COUNT} bands and ${FINE_BAND_COUNT} fine bands per tick`);
  return { name, dump };
}

/** A fresh replay of the track from its start, followed at the given reactivity. Holds the last tick past the end. */
export function createLabReplay(dump: TrackDump, reactivity: Reactivity): LabSong {
  const follower = createSignalFollower();
  const rest = new Array<number>(BAND_COUNT).fill(0);
  let clock = 0;
  let tick = -1;
  let bands: number[] = rest;
  let level: LevelFrame = { rms: 0, peak: 0, flux: 0, rmsDb: -120 };
  let fineRaw: number[] = new Array(FINE_BAND_COUNT).fill(0);
  let fine: number[] = [];

  return {
    step(dt) {
      clock += dt;
      const latest = Math.min(dump.ticks - 1, Math.floor((clock * 1000) / dump.tickMs) - 1);
      if (latest > tick) {
        tick = latest;
        bands = dump.bands[tick];
        level = { rms: dump.rms[tick], peak: dump.peak[tick], flux: dump.flux[tick], rmsDb: dump.rmsDb[tick] };
        fineRaw = dump.fine[tick];
      }
      const sig = follower.step(dt, { bands, level, playing: true, reactivity });
      fine = smoothBands(fine, fineRaw, FINE_ATTACK, FINE_DECAY);
      return { sig, fine, bands, level };
    },
  };
}
