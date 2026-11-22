/*
 * Developer-mode feed recording: 30 seconds of the exact ticks sent to one kind's live, shown stage frame,
 * saved as a recording the kit harness replays. Ticks are read where the transport sends them, so a folded
 * tick is recorded folded, as the frame saw it; time starts at zero on the first. A recording that ends
 * early, because the frame left the stage or the file would pass the save limit, is kept when it is long
 * enough to replay. One recording runs at a time.
 */

// -- State Imports --
import { usePluginsStore } from "../../plugins/store";
import { isShownStage, stageHandles, watchStages, type StageHandle } from "./frameCache";
import { feedTapOf, type FeedTap } from "./feedTap";
import { publishFeedRecording } from "./feedRecording";
import type { FeedOutcome } from "./feedRecording";

// -- IPC Imports --
import { pluginVisRecordSave } from "../../../lib/ipc";

// -- Local Imports --
import { SIGNAL_FOLD, type Tick } from "../../../visRuntime/protocol";

// -- Type Imports --
import type { VisualSignal } from "../visualSignal";

/** How long a recording runs. */
export const RECORD_MS = 30_000;
/** The shortest recording kept when the frame leaves early, in seconds. */
export const RECORD_KEEP_MIN_SECS = 3;
/** How often a running recording checks that its frame is still shown. */
export const RECORD_ALIVE_MS = 250;
/** A recording ends here, under the save command's own 8 MiB limit. */
export const RECORD_MAX_BYTES = 7 * 1024 * 1024;

/** Why a recording was refused or lost. */
export type RecordRefusal =
  "dev_mode_off" | "not_on_stage" | "busy" | "stage_left" | "too_short" | "save_failed";

export class FeedRecordError extends Error {
  readonly reason: RecordRefusal;
  // The save's own message, for `save_failed`.
  readonly detail: string | null;
  constructor(reason: RecordRefusal, detail: string | null = null) {
    super(detail ?? reason);
    this.name = "FeedRecordError";
    this.reason = reason;
    this.detail = detail;
  }
}

/** The typed reason a failed save stands for: the command's `dev_mode_off` code, else a save failure. */
function saveFailure(error: unknown): FeedRecordError {
  const { code, detail, message } = (error ?? {}) as { code?: unknown; detail?: unknown; message?: unknown };
  if (code === "dev_mode_off") return new FeedRecordError("dev_mode_off");
  const text = [detail, message, error].find((v) => typeof v === "string" && v !== "");
  return new FeedRecordError("save_failed", typeof text === "string" ? text : "the recording was not saved");
}

export interface RecordDeps {
  devMode: () => boolean;
  stages: () => readonly StageHandle[];
  // Calls `notify` whenever a stage frame is listed or leaves.
  watch: (notify: () => void) => () => void;
  tapOf: (handle: StageHandle) => FeedTap | null;
  // Saves the recording for a plugin and its own kind id; resolves with the file's path.
  save: (pluginId: string, kindId: string, json: string) => Promise<string>;
}

const productionDeps: RecordDeps = {
  devMode: () => usePluginsStore.getState().devMode,
  stages: stageHandles,
  watch: watchStages,
  tapOf: (handle) => feedTapOf(handle.stats),
  save: pluginVisRecordSave,
};

// Signal values are written to 4 decimals; time, `dt` and `beatAt` to 6. `seq` and `pointer` are not kept.
const round = (value: number, places = 4) => {
  if (!Number.isFinite(value)) return 0;
  const scale = 10 ** places;
  return Math.round(value * scale) / scale;
};
const list = (values: ArrayLike<number> | null) => (values ? Array.from(values, (v) => round(v)) : null);

/** One tick as the harness reads it back: plain arrays, time from `origin`, no pointer. */
function recorded(tick: Tick, origin: number) {
  const sig: Record<string, number | number[] | null> = {};
  for (const key of Object.keys(SIGNAL_FOLD) as (keyof VisualSignal)[]) {
    sig[key] = key === "bands" ? list(tick.sig.bands) : round(tick.sig[key] as number);
  }
  return {
    t: round(tick.t - origin, 6),
    dt: round(tick.dt, 6),
    sig,
    nBeats: tick.nBeats,
    beatAt: tick.beatAt === null ? null : round(tick.beatAt, 6),
    rawBands: list(tick.rawBands),
    fine: list(tick.fine),
    playing: tick.playing,
    trackSeq: tick.trackSeq,
    progress: tick.progress === null ? null : round(tick.progress),
    wave: list(tick.wave),
  };
}

let running = false;
// Ends the running recording early, or null while none runs.
let stopRunning: (() => void) | null = null;

/** Ends the running recording now: kept at 3 seconds or more, else it rejects as too_short. */
export function stopFeedRecording(): void {
  stopRunning?.();
}

/**
 * Records the feed of the kind's stage frame (`<plugin id>/<kind id>`) for 30 seconds and saves it. Resolves
 * with the saved file's path. Rejects with a FeedRecordError: developer mode off, no live shown frame for
 * the kind, a recording already running, or the frame leaving with under 3 seconds recorded.
 */
export function startFeedRecording(
  kind: string,
  deps: RecordDeps = productionDeps,
): Promise<{ path: string }> {
  // A refusal while another recording runs leaves that recording's state alone.
  const refuse = (reason: RecordRefusal) => {
    if (reason !== "busy") {
      publishFeedRecording({
        kind,
        phase: "idle",
        startedAt: 0,
        outcome: { ok: false, reason, detail: null },
      });
    }
    return Promise.reject(new FeedRecordError(reason));
  };
  if (!deps.devMode()) return refuse("dev_mode_off");
  if (running) return refuse("busy");
  const handle = deps.stages().find((h) => h.kind === kind && isShownStage(h));
  const tap = handle ? deps.tapOf(handle) : null;
  const slash = kind.indexOf("/");
  if (!handle || !tap || slash < 0) return refuse("not_on_stage");

  running = true;
  publishFeedRecording({ kind, phase: "recording", startedAt: Date.now(), outcome: null });
  return new Promise((resolve, reject) => {
    const ticks: ReturnType<typeof recorded>[] = [];
    let origin: number | null = null;
    let bytes = 0;
    let finished = false;
    let stopped = false;
    const ended = (outcome: FeedOutcome) => {
      running = false;
      publishFeedRecording({ kind, phase: "idle", startedAt: 0, outcome });
    };
    const lose = (error: FeedRecordError) => {
      ended({ ok: false, reason: error.reason, detail: error.detail });
      reject(error);
    };
    let release = () => {};
    let unwatch = () => {};
    let timer: ReturnType<typeof setTimeout> | undefined;
    let poll: ReturnType<typeof setInterval> | undefined;
    const alive = () => deps.stages().includes(handle) && isShownStage(handle);

    const finish = (early: boolean) => {
      if (finished) return;
      finished = true;
      stopRunning = null;
      clearTimeout(timer);
      clearInterval(poll);
      release();
      unwatch();
      const last = ticks[ticks.length - 1];
      const secs = last ? last.t + last.dt : 0;
      if (!last || (early && secs < RECORD_KEEP_MIN_SECS)) {
        lose(new FeedRecordError(stopped ? "too_short" : "stage_left"));
        return;
      }
      // Developer mode can go off while recording; nothing is saved then.
      if (!deps.devMode()) {
        lose(new FeedRecordError("dev_mode_off"));
        return;
      }
      const json = JSON.stringify({ kind, ticks });
      publishFeedRecording({ kind, phase: "saving", startedAt: 0, outcome: null });
      deps.save(kind.slice(0, slash), kind.slice(slash + 1), json).then(
        (path) => {
          ended({ ok: true, path });
          resolve({ path });
        },
        (e) => lose(saveFailure(e)),
      );
    };

    stopRunning = () => {
      stopped = true;
      finish(true);
    };
    release = tap((tick) => {
      origin ??= tick.t;
      const one = recorded(tick, origin);
      ticks.push(one);
      bytes += JSON.stringify(one).length;
      if (!alive()) finish(true);
      else if (bytes >= RECORD_MAX_BYTES) finish(false);
    });
    unwatch = deps.watch(() => {
      if (!alive()) finish(true);
    });
    // A hidden frame gets no ticks, so loss of the stage is also looked for on a clock.
    poll = setInterval(() => {
      if (!alive()) finish(true);
    }, RECORD_ALIVE_MS);
    timer = setTimeout(() => finish(!alive()), RECORD_MS);
  });
}
