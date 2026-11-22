/*
 * The stage nets over every mounted plugin visualizer frame, run off React from a display loop that runs
 * only while a frame is mounted. Each frame gets a hang and a slow-frame watch; one that trips stops its
 * kind for the session and the stage fades to the fallback. A frame whose flash meter tripped is handled
 * by the stop-flashing setting. A stopped kind's frames end: at once for a mark, once faded out for a
 * session stop. The loop also reports the shown hosts, and a beat re-reports them while a frame is mounted.
 * The kinds on a visible stage go to the graphics-reset sentinel whenever that set changes.
 */

// -- Local Imports --
import { isFrameWanted, stageHandles, watchStages, type StageHandle } from "./frameCache";
import { createHangWatch, createSlowWatch } from "./nets";
import { createShownReporter } from "./shownHosts";
import {
  flashActionNow,
  isKindStopped,
  meterWanted,
  stopForSession,
  useNetPolicy,
  writeVisMark,
  type SessionStop,
} from "./netPolicy";
import type { ResetKind, TrialKind } from "./useResetSentinel";

// -- State Imports --
import { pluginVisualizer, type PluginKindId } from "../pluginVisualizers";
import { usePluginsStore } from "../../plugins/store";
import { selectStopFlashing, usePreferencesStore } from "../../preferences/store";

// -- Type Imports --
import type { FlashReading } from "../../../visRuntime/protocol";
import type { PluginNotice, VisualizerStopCause } from "../../../types";

/** How often the shown hosts are reported again while a frame is mounted. */
export const SHOWN_BEAT_MS = 3000;

export interface NetsDeps {
  frame: (step: (now: number) => void) => number;
  cancelFrame: (id: number) => void;
  every: (ms: number, beat: () => void) => ReturnType<typeof setInterval>;
  stopEvery: (id: ReturnType<typeof setInterval>) => void;
  report: (hosts: string[]) => void;
  notice: (notice: PluginNotice) => void;
  // A tripped meter's reading that stops nothing, for dev mode.
  log: (kind: PluginKindId, reading: FlashReading) => void;
  // The kinds on a visible stage, whenever that set changes.
  onKinds: (kinds: TrialKind[]) => void;
  // Whether the document is visible.
  docVisible: () => boolean;
}

interface Watch {
  hang: ReturnType<typeof createHangWatch>;
  slow: ReturnType<typeof createSlowWatch>;
  logged: boolean;
  flashed: boolean;
}

/** A kind's plugin id and declared kind id. */
export function resetKindOf(kind: PluginKindId): ResetKind {
  const descriptor = pluginVisualizer(kind);
  if (descriptor) return { kind, pluginId: descriptor.pluginId, kindId: descriptor.kindId };
  const slash = kind.indexOf("/");
  return { kind, pluginId: kind.slice(0, slash), kindId: kind.slice(slash + 1) };
}

export function stopNotice(kind: PluginKindId, cause: VisualizerStopCause): PluginNotice {
  return { id: resetKindOf(kind).pluginId, kind: "visualizer_stopped", visualizer: kind, cause };
}

const live = (h: StageHandle) => h.phase() !== "dropped" && h.phase() !== "failed";

/**
 * A graphics reset laid on the kinds in their trial: marks each, which ends their frames, and says so once,
 * naming the kind on the stage, else the first.
 */
export function layReset(kinds: readonly ResetKind[], notice: (notice: PluginNotice) => void): void {
  if (kinds.length === 0) return;
  for (const k of kinds) void writeVisMark(k.kind, k.pluginId, k.kindId, "graphics_reset");
  const shown = stageHandles().find((h) => h.shown() && kinds.some((k) => k.kind === h.kind));
  notice(stopNotice(shown?.kind ?? kinds[0].kind, "graphics_reset"));
}

// A kind is on the stage once its frame is shown or the dip aims at it, compile included.
const onStage = (h: StageHandle) => live(h) && (h.shown() || isFrameWanted(h.surface, h.kind));

/** Starts the nets; the returned `stop` ends them. `sample` reports the shown hosts and kinds on a change. */
export function startStageNets(deps: NetsDeps): { sample: () => void; stop: () => void } {
  const watches = new Map<StageHandle, Watch>();
  const reporter = createShownReporter({ handles: stageHandles, report: deps.report });
  let raf: number | null = null;
  let beat: ReturnType<typeof setInterval> | null = null;
  let kindsKey = "";

  const publishKinds = () => {
    const ready = new Map<PluginKindId, boolean>();
    if (deps.docVisible()) {
      for (const h of stageHandles().filter(onStage)) {
        ready.set(h.kind, ready.get(h.kind) === true || h.phase() === "ready");
      }
    }
    const kinds = [...ready.keys()].sort();
    const key = kinds.map((kind) => `${kind}:${ready.get(kind)}`).join("\n");
    if (key === kindsKey) return;
    kindsKey = key;
    deps.onKinds(kinds.map((kind) => ({ ...resetKindOf(kind), ready: ready.get(kind) === true })));
  };

  // Ends a stopped kind's frame; true when the kind is stopped.
  const endIfStopped = (h: StageHandle): boolean => {
    if (!isKindStopped(h.kind)) return false;
    const session = useNetPolicy.getState().session[h.kind];
    if (session === undefined || !h.shown()) h.end();
    else h.hold(false);
    return true;
  };

  const trip = (h: StageHandle, cause: SessionStop) => {
    if (stopForSession(h.kind, cause)) deps.notice(stopNotice(h.kind, cause));
  };

  const checkFlash = (h: StageHandle, w: Watch) => {
    const reading = h.flash();
    if (!reading || w.flashed) return;
    const action = flashActionNow(h.kind);
    if (action === "log" && !w.logged) {
      w.logged = true;
      deps.log(h.kind, reading);
    }
    if (action !== "stop") return;
    w.flashed = true;
    const { pluginId, kindId } = resetKindOf(h.kind);
    void writeVisMark(h.kind, pluginId, kindId, "flashing");
    deps.notice(stopNotice(h.kind, "flashing"));
    h.end();
  };

  const step = (now: number) => {
    const handles = stageHandles();
    for (const h of handles) {
      let w = watches.get(h);
      if (!w) {
        w = { hang: createHangWatch(), slow: createSlowWatch(), logged: false, flashed: false };
        watches.set(h, w);
      }
      const phase = h.phase();
      if (!live(h) || endIfStopped(h)) continue;
      const input = { now, phase, stats: h.stats(), slotVisible: h.visible() };
      const slow = w.slow.step(input);
      h.hold(slow.hold);
      if (w.hang.step(input)) trip(h, "hang");
      else if (slow.slow) trip(h, "slow");
      checkFlash(h, w);
    }
    for (const h of watches.keys()) if (!handles.includes(h)) watches.delete(h);
    reporter.sample();
    publishKinds();
  };

  const loop = (now: number) => {
    raf = null;
    step(now);
    if (stageHandles().length > 0) raf = deps.frame(loop);
  };

  const sync = () => {
    if (stageHandles().length > 0) {
      raf ??= deps.frame(loop);
      beat ??= deps.every(SHOWN_BEAT_MS, () => reporter.beat());
      publishKinds();
      return;
    }
    if (raf != null) deps.cancelFrame(raf);
    if (beat != null) deps.stopEvery(beat);
    raf = null;
    beat = null;
    watches.clear();
    reporter.sample();
    publishKinds();
  };

  const release = watchStages(sync);
  sync();
  return {
    sample() {
      reporter.sample();
      publishKinds();
    },
    stop() {
      release();
      if (raf != null) deps.cancelFrame(raf);
      if (beat != null) deps.stopEvery(beat);
      raf = null;
      beat = null;
    },
  };
}

/**
 * Switches each mounted frame's meter whenever the setting, dev mode or the marks change. Turning the
 * setting on switches a running meter off and on again, so only a reading taken from then on can act.
 */
export function watchMeters(): () => void {
  const apply = () => {
    for (const h of stageHandles()) h.setMeter(meterWanted(h.kind));
  };
  const stops = [
    usePreferencesStore.subscribe((s, prev) => {
      if (selectStopFlashing(s) && !selectStopFlashing(prev)) {
        for (const h of stageHandles()) h.setMeter(false);
      }
      apply();
    }),
    usePluginsStore.subscribe((s, prev) => {
      if (s.devMode !== prev.devMode) apply();
    }),
    useNetPolicy.subscribe(apply),
    watchStages(apply),
  ];
  return () => stops.forEach((stop) => stop());
}
