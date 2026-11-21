/*
 * Where each plugin kind's stage frames stand, shared by the dip and the stages. The dip aims at a plugin
 * kind only once one of its frames has drawn, and at the fallback while it is slow or gone, so the outgoing
 * kind holds meanwhile. A stage keeps the last frame it stopped showing for a while, hidden and unticked,
 * so a quick return reuses it instead of compiling again. Aims and phases are keyed by surface and kind, so
 * each surface dips on its own frame; a given-up or failed frame keeps its phase until its surface aims at
 * the kind again, which retries it.
 */

// -- Framework Imports --
import { useEffect, useState } from "react";

// -- Library Imports --
import { create } from "zustand";

// -- State Imports --
import { isPluginKindId, pluginVisualizer, type PluginKindId } from "../pluginVisualizers";

// -- Type Imports --
import type { VisualizerKind } from "../visualizerKind";
import type { StagePhase } from "./stageMount";
import type { TransportStats } from "./transport";

export type StageSurface = "player" | "ambient";

/** How long a stage keeps the last frame it stopped showing. */
export const FRAME_KEEP_MS = 10_000;
/** A plugin tile's preview dwell: each preview may start a frame, so a passing pointer must not. */
export const PLUGIN_PREVIEW_DWELL_MS = 400;
/** What a plugin kind's stage shows while its frame is slow, given up on or failed. */
export const STAGE_FALLBACK: VisualizerKind = "ridge";

interface FrameCacheState {
  // How many dips aim at each plugin kind, by `surface|kind`.
  wants: Readonly<Record<string, number>>;
  // By `surface|kind`.
  phases: Readonly<Record<string, StagePhase>>;
}

export const useFrameCache = create<FrameCacheState>(() => ({ wants: {}, phases: {} }));

const phaseKey = (surface: StageSurface, kind: PluginKindId) => `${surface}|${kind}`;
const ended = (phase: StagePhase | undefined) => phase === "dropped" || phase === "failed";

/**
 * Marks a kind as aimed at on a surface until the returned release runs. The first aim clears a given-up
 * or failed phase there, so aiming at the kind again mounts a fresh frame.
 */
export function wantFrame(surface: StageSurface, kind: PluginKindId): () => void {
  const key = phaseKey(surface, kind);
  useFrameCache.setState((s) => {
    const held = s.wants[key] ?? 0;
    if (held > 0) return { wants: { ...s.wants, [key]: held + 1 } };
    if (!ended(s.phases[key])) return { wants: { ...s.wants, [key]: 1 } };
    const { [key]: _gone, ...phases } = s.phases;
    return { wants: { ...s.wants, [key]: 1 }, phases };
  });
  let released = false;
  return () => {
    if (released) return;
    released = true;
    useFrameCache.setState((s) => {
      const { [key]: held = 0, ...rest } = s.wants;
      return { wants: held > 1 ? { ...rest, [key]: held - 1 } : rest };
    });
  };
}

/** Whether a dip on the surface aims at the kind now. */
export const isFrameWanted = (surface: StageSurface, kind: PluginKindId): boolean =>
  (useFrameCache.getState().wants[phaseKey(surface, kind)] ?? 0) > 0;

export function reportPhase(surface: StageSurface, kind: PluginKindId, phase: StagePhase): void {
  const key = phaseKey(surface, kind);
  if (useFrameCache.getState().phases[key] === phase) return;
  useFrameCache.setState((s) => ({ phases: { ...s.phases, [key]: phase } }));
}

/** A stage leaving: forgets its phase, unless it gave up or failed, which holds the fallback. */
export function leavePhase(surface: StageSurface, kind: PluginKindId): void {
  const key = phaseKey(surface, kind);
  const phase = useFrameCache.getState().phases[key];
  if (phase === undefined || ended(phase)) return;
  useFrameCache.setState((s) => {
    const { [key]: _gone, ...rest } = s.phases;
    return { phases: rest };
  });
}

/** The phase of a kind's frame on one surface, if it has one. */
export function phaseOf(surface: StageSurface, kind: PluginKindId): StagePhase | undefined {
  return useFrameCache.getState().phases[phaseKey(surface, kind)];
}

/** The plugin kinds the dips on a surface aim at, from the `surface|kind` aim keys. */
function wantedOn(surface: StageSurface, wants: FrameCacheState["wants"]): string[] {
  const prefix = `${surface}|`;
  return Object.keys(wants).filter((key) => key.startsWith(prefix)).map((key) => key.slice(prefix.length));
}

export interface StageAim {
  target: VisualizerKind;
  ready: boolean;
}

/**
 * Where the dip heads for a target. A built-in kind passes through. A plugin kind that is not ready for
 * other reasons holds; one that is not installed, or whose frame is slow, given up on or failed, shows the
 * fallback; one whose frame drew is ready; otherwise the outgoing kind holds while the frame compiles.
 */
export function stageAim(
  target: VisualizerKind,
  ready: boolean,
  phase: StagePhase | undefined,
  known: boolean,
): StageAim {
  if (!isPluginKindId(target) || !ready) return { target, ready };
  if (!known || phase === "slow" || ended(phase)) return { target: STAGE_FALLBACK, ready: true };
  return { target, ready: phase === "ready" };
}

/** The phase of a kind's frame on one surface; undefined for a built-in kind. */
export function usePluginPhase(surface: StageSurface, kind: VisualizerKind | null): StagePhase | undefined {
  const key = kind != null && isPluginKindId(kind) ? phaseKey(surface, kind) : null;
  return useFrameCache((s) => (key == null ? undefined : s.phases[key]));
}

/** Whether an installed plugin kind's frame is still on its way to its first frame, slow included. */
export function pluginLoading(kind: VisualizerKind | null, phase: StagePhase | undefined): boolean {
  if (kind == null || !isPluginKindId(kind) || !pluginVisualizer(kind)) return false;
  return phase !== "ready" && !ended(phase);
}

/** The preview dwell for a kind: longer for a plugin kind, else the sheet's own. */
export function previewDwellMs(kind: VisualizerKind | null, builtIn: number): number {
  return kind != null && isPluginKindId(kind) ? Math.max(builtIn, PLUGIN_PREVIEW_DWELL_MS) : builtIn;
}

// -- Kept frames --

/** One stage's frames: the live ones, and the last one to leave, kept until `until`. */
export interface FrameKeep {
  live: readonly PluginKindId[];
  kept: { kind: PluginKindId; until: number } | null;
}

/** The plugin kinds a stage mounts now: the shown one first, then every kind its dip aims at, minus ended. */
export function liveFrames(
  shown: VisualizerKind,
  wanted: readonly string[],
  gone: (kind: PluginKindId) => boolean,
): PluginKindId[] {
  const out: PluginKindId[] = [];
  for (const kind of [shown, ...wanted]) {
    if (isPluginKindId(kind) && !gone(kind) && !out.includes(kind)) out.push(kind);
  }
  return out;
}

const sameKinds = (a: readonly string[], b: readonly string[]) =>
  a.length === b.length && a.every((kind, i) => kind === b[i]);

/**
 * The keep after the live set changes: the first kind to leave, the shown one when it left, is kept for
 * the keep time; a kind back in the live set is no longer kept. An ended kind is never kept.
 */
export function keepStep(
  prev: FrameKeep,
  live: readonly PluginKindId[],
  now: number,
  gone: (kind: PluginKindId) => boolean,
): FrameKeep {
  if (sameKinds(prev.live, live)) return prev;
  const left = prev.live.find((kind) => !live.includes(kind) && !gone(kind));
  let kept = left ? { kind: left, until: now + FRAME_KEEP_MS } : prev.kept;
  if (kept && (live.includes(kept.kind) || gone(kept.kind) || kept.until <= now)) kept = null;
  return { live, kept };
}

/** The kinds a stage renders frames for: the live ones, then the kept one. */
export function keptFrames(keep: FrameKeep, gone: (kind: PluginKindId) => boolean): PluginKindId[] {
  const { live, kept } = keep;
  return kept && !gone(kept.kind) && !live.includes(kept.kind) ? [...live, kept.kind] : [...live];
}

/** The plugin frames one stage renders for its shown kind, with the last one to leave kept a while. */
export function usePluginFrames(surface: StageSurface, shown: VisualizerKind): PluginKindId[] {
  const wants = useFrameCache((s) => s.wants);
  const phases = useFrameCache((s) => s.phases);
  const gone = (kind: PluginKindId) => ended(phases[phaseKey(surface, kind)]);
  const live = liveFrames(shown, wantedOn(surface, wants), gone);
  const [keep, setKeep] = useState<FrameKeep>({ live, kept: null });
  let current = keep;
  if (!sameKinds(keep.live, live)) {
    current = keepStep(keep, live, performance.now(), gone);
    setKeep(current);
  }
  const { kept } = current;
  useEffect(() => {
    if (!kept) return;
    const timer = setTimeout(
      () => setKeep((k) => (k.kept === kept ? { ...k, kept: null } : k)),
      Math.max(0, kept.until - performance.now()),
    );
    return () => clearTimeout(timer);
  }, [kept]);
  return keptFrames(current, gone);
}

// -- Mount handles --

/** What a mounted stage frame exposes to the code that watches frames. */
export interface StageHandle {
  surface: StageSurface;
  kind: PluginKindId;
  phase: () => StagePhase;
  // Whether the slot may be ticked now.
  visible: () => boolean;
  // Null until the frame is initialised.
  stats: () => TransportStats | null;
  // The frame's URL, or null until it is known.
  url: () => string | null;
}

const handles = new Set<StageHandle>();

/** Lists a mounted frame until the returned release runs. */
export function registerStage(handle: StageHandle): () => void {
  handles.add(handle);
  return () => {
    handles.delete(handle);
  };
}

/** Every mounted stage frame, kept ones included. */
export function stageHandles(): readonly StageHandle[] {
  return [...handles];
}
