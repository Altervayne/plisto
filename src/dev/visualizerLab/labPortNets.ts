/*
 * The lab's `port-nets` mode: plays each plugin fixture through the runtime bundle over a window of the lab
 * song, the way the host will drive it, and reads what the stage nets would. One tick per 60 fps lab frame
 * goes over the mount's port under the host's credit window, and the lab waits for each ack, so a frame
 * that stalls is seen as it is. Per kind it reports the cell meter's reading of the canvas the runtime
 * draws, the median and worst step cost the runtime acked, and the time from init to the first shown frame.
 * Canvas readings are taken inside the animation frame that drew them, 20 a second, and only inside the read
 * window; the frames before it are played so a stateful kind is settled when the reading starts.
 */

// -- Local Imports --
import { fixtureSource, initFor, loadKind, standInWindow } from "./labPort";
import { createTickBuilder, frameStats } from "./labNetStats";
import { round } from "./labPixels";
import { applyTheme, reseed, sceneTheme, type LabLayoutId, type LabTheme } from "./labScene";
import { createLabSong } from "./labSong";
import { createLabReplay, type LoadedTrack } from "./labReplay";
import {
  CELL_H,
  CELL_HZ,
  CELL_W,
  FLASHES_PER_SEC_LIMIT,
  createCellMeter,
} from "../../components/player/visualizers/flash/cellMeter";
import { createTickSender } from "../../visRuntime/protocol";

// -- State Imports --
import {
  isDarkOnly,
  needsFineSpectrum,
  type Reactivity,
  type VisualizerKind,
} from "../../state/player/visualizerKind";

// -- Type Imports --
import type { ReadWindow } from "./labParams";
import type { FrameMessage } from "../../visRuntime/protocol";

export interface PortNetsRun {
  kinds: string[];
  themes: LabTheme[];
  layouts: LabLayoutId[];
  cover: ImageBitmap;
  // The seconds of the song, or of the track, that are read.
  window: ReadWindow;
  reactivity: Reactivity;
  track: LoadedTrack | null;
}

export interface NetRow {
  kind: string;
  theme: string;
  layout: string;
  flashesPerSec: number | null;
  redFlashesPerSec: number | null;
  // Whether the cell meter's reading breaks its rule.
  tripped: boolean | null;
  medianMs: number | null;
  worstMs: number | null;
  firstFrameMs: number | null;
  readings: number;
  error?: string;
}

const DT = 1 / 60;
// Lab frames between canvas readings, so the meter sees CELL_HZ of them a second.
const READ_EVERY = Math.round(1 / DT / CELL_HZ);
// A tick that is not acked within this long fails the row.
const ACK_TIMEOUT_MS = 60000;

/** What a mount reported on its port, as the loop below needs it. */
interface Mount {
  readyMs: number | null;
  failure: string | null;
  acked: number;
  costs: { seq: number; ms: number }[];
}

/** Plays one kind over the window and reads it. */
async function playKind(source: string, kind: string, theme: LabTheme, layout: LabLayoutId, run: PortNetsRun) {
  const withFine = kind !== "ridge" && needsFineSpectrum(kind as VisualizerKind);
  const init = initFor(kind, theme, layout, run.cover, withFine);
  const { stand, deliver } = standInWindow();
  const cells = createCellMeter();
  const scratch = document.createElement("canvas");
  scratch.width = CELL_W;
  scratch.height = CELL_H;
  const g = scratch.getContext("2d", { willReadFrequently: true }) as CanvasRenderingContext2D;
  const { from, length } = run.window;

  // The runtime draws inside its animation frame callback; a reading has to be taken there, before the
  // drawing buffer is handed on. `drawnAt` marks a callback in which the kind drew.
  let canvas: HTMLCanvasElement | null = null;
  let drawnAt: number | null = null;
  let sampled = 0;
  let readings = 0;
  const sample = () => {
    const t = drawnAt;
    drawnAt = null;
    if (t === null || !canvas || t < from) return;
    if (sampled++ % READ_EVERY !== 0) return;
    g.clearRect(0, 0, CELL_W, CELL_H);
    g.drawImage(canvas, 0, 0, CELL_W, CELL_H);
    cells.frame(new Uint8Array(g.getImageData(0, 0, CELL_W, CELL_H).data.buffer));
    readings++;
  };
  loadKind(source, stand, {
    candidate(c) {
      const draw = c.draw;
      c.draw = (f) => {
        draw(f);
        drawnAt = f.t;
      };
      return c;
    },
    raw: (h) => ({
      ...h,
      frame(f) {
        h.frame(f);
        drawnAt = f.t;
      },
    }),
  });
  const realFrame = window.requestAnimationFrame;
  window.requestAnimationFrame = (cb) =>
    realFrame.call(window, (now) => {
      cb(now);
      sample();
    });

  const mount: Mount = { readyMs: null, failure: null, acked: 0, costs: [] };
  const { port1, port2 } = new MessageChannel();
  let wake: (() => void) | null = null;
  const sender = createTickSender((tick) => port1.postMessage({ type: "tick", ...tick }));
  port1.onmessage = (e: MessageEvent<FrameMessage>) => {
    const m = e.data;
    if (m.type === "ack") {
      sender.ack(m.seq);
      mount.acked = Math.max(mount.acked, m.seq);
      if (m.ms !== null) mount.costs.push({ seq: m.seq, ms: m.ms });
    } else if (m.type === "ready" && mount.readyMs === null) {
      mount.readyMs = performance.now() - startedAt;
    } else if (m.type === "error") mount.failure = `${m.stage}: ${m.message}`;
    else if (m.type === "lost") mount.failure = "the context was lost";
    wake?.();
  };
  const untilAcked = (seq: number) =>
    new Promise<void>((resolve, reject) => {
      const timer = window.setTimeout(
        () => reject(new Error(`no ack for tick ${seq} within ${ACK_TIMEOUT_MS} ms`)),
        ACK_TIMEOUT_MS,
      );
      wake = () => {
        if (mount.failure) reject(new Error(mount.failure));
        else if (mount.acked < seq) return;
        else resolve();
        window.clearTimeout(timer);
        wake = null;
      };
      wake();
    });

  const song = run.track ? createLabReplay(run.track.dump, run.reactivity) : createLabSong(0, run.reactivity);
  const ticks = createTickBuilder(withFine);
  const frames = Math.round((from + length) / DT);
  const windowStart = Math.ceil(from / DT - 1e-6);
  let startedAt = 0;
  try {
    reseed();
    const before = new Set(document.querySelectorAll("canvas"));
    startedAt = performance.now();
    deliver(init, port2);
    canvas = [...document.querySelectorAll("canvas")].find((c) => !before.has(c)) ?? null;
    for (let i = 0; i < frames; i++) {
      const tick = ticks.next(song.step(DT), i * DT, DT);
      sender.offer(tick);
      await untilAcked(tick.seq);
    }
    if (mount.readyMs === null) throw new Error("no frame was shown");
  } finally {
    port1.postMessage({ type: "dispose" });
    port1.close();
    window.requestAnimationFrame = realFrame;
  }
  // An ack carries the cost of the step before the tick it acks; that tick is index seq - 2.
  const costs = mount.costs.filter((c) => c.seq - 2 >= windowStart).map((c) => c.ms);
  return { cells, costs, readings, readyMs: mount.readyMs };
}

/** One row per kind, theme and layout, with the song window the readings were taken over. */
export async function runPortNets(run: PortNetsRun) {
  const rows: NetRow[] = [];
  for (const kind of run.kinds) {
    const source = await fixtureSource(kind);
    for (const theme of run.themes) {
      const drawn = sceneTheme(isDarkOnly(kind as VisualizerKind), theme);
      applyTheme(drawn);
      for (const layout of run.layouts) {
        const head = { kind, theme: drawn, layout };
        try {
          const seen = await playKind(source, kind, drawn, layout, run);
          const reading = seen.cells.reading();
          const stats = frameStats(seen.costs);
          rows.push({
            ...head,
            flashesPerSec: reading.flashesPerSec,
            redFlashesPerSec: reading.redFlashesPerSec,
            tripped: seen.cells.tripped(),
            medianMs: stats && round(stats.medianMs),
            worstMs: stats && round(stats.worstMs),
            firstFrameMs: round(seen.readyMs),
            readings: seen.readings,
          });
        } catch (e) {
          const error = e instanceof Error ? e.message : String(e);
          rows.push({
            ...head,
            flashesPerSec: null,
            redFlashesPerSec: null,
            tripped: null,
            medianMs: null,
            worstMs: null,
            firstFrameMs: null,
            readings: 0,
            error,
          });
        }
      }
    }
  }
  const { from, length } = run.window;
  const source = run.track ? `track ${run.track.name}` : "song";
  return {
    mode: "port-nets",
    source: `${source} time ${from} s to ${round(from + length)} s (${length} s), 60 fps, pixel ratio 1`,
    reactivity: run.reactivity,
    columns:
      "flashesPerSec and redFlashesPerSec: the worst the cell meter read on the 64 x 36 canvas, " +
      "20 readings a second; " +
      `tripped: the rule broke (over ${FLASHES_PER_SEC_LIMIT} luminance flashes a second, or any red); ` +
      "medianMs and worstMs: the step cost the runtime acked, over the read window; " +
      "firstFrameMs: init to the first shown frame, pre-roll and compile included; " +
      "readings: canvas readings taken",
    rows,
  };
}
