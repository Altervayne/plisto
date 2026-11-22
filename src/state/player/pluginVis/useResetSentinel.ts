/*
 * The graphics-reset sentinel. While a plugin kind is on a visible stage, a 1x1 WebGL context of Plisto's
 * own listens for a lost context, which a reset of the graphics process brings to every context at once.
 * Each kind runs a trial for its first seconds under a build: the backend keeps a marker for it from the
 * moment the kind enters, compile included, so a reset that takes Plisto down with it still marks the kind
 * at next launch. The trial passes once the kind has drawn for the trial time. A loss inside trials is laid
 * on their kinds at once; a kind that leaves first ends its trial unpassed, which only removes the marker.
 * A short-lived offscreen mount (a still or a thumbnail) keeps the context open while it lives and has a
 * loss laid on its kind, but runs no trial: the marker is one per kind, so it belongs to the stage alone.
 */

// -- Framework Imports --
import { useEffect, useRef } from "react";

// -- IPC Imports --
import { pluginVisTrialBegin, pluginVisTrialEnd } from "../../../lib/ipc";

// -- Type Imports --
import type { PluginKindId } from "../pluginVisualizers";

/** How long a kind draws before its trial passes. */
export const TRIAL_MS = 10_000;

export interface ResetKind {
  kind: PluginKindId;
  pluginId: string;
  kindId: string;
}

/** A kind on a visible stage, and whether one of its frames there has drawn. */
export interface TrialKind extends ResetKind {
  ready: boolean;
}

/** What the sentinel listens on; a real 1x1 WebGL canvas outside tests. */
export interface LossTarget {
  addEventListener: (type: "webglcontextlost", listener: () => void) => void;
  removeEventListener: (type: "webglcontextlost", listener: () => void) => void;
  // Gives the live context back, so the sentinel never holds one it no longer needs.
  release: () => void;
}

export interface ResetSentinelOptions {
  begin: (pluginId: string, kindId: string) => Promise<boolean>;
  end: (pluginId: string, kindId: string, passed: boolean) => Promise<void>;
  // The kinds inside their trial when the context was lost, once per loss.
  onLoss: (kinds: ResetKind[]) => void;
  // Opens the context to listen on; null when WebGL is unavailable.
  target: () => LossTarget | null;
}

interface Trial {
  kind: ResetKind;
  ready: boolean;
  // Begun and not yet ended.
  running: boolean;
  timer: ReturnType<typeof setTimeout> | null;
}

export function createResetSentinel(options: ResetSentinelOptions) {
  const trials = new Map<string, Trial>();
  const offscreens = new Set<{ kind: ResetKind }>();
  let target: LossTarget | null = null;
  let disposed = false;

  const onLost = () => {
    // The context is dead: dropped without giving it back, and a fresh one opens on the next set.
    target?.removeEventListener("webglcontextlost", onLost);
    target = null;
    const lost = new Map<string, ResetKind>();
    for (const trial of trials.values()) if (trial.running) lost.set(trial.kind.kind, trial.kind);
    for (const { kind } of offscreens) if (!lost.has(kind.kind)) lost.set(kind.kind, kind);
    if (lost.size > 0) options.onLoss([...lost.values()]);
  };
  const finish = (trial: Trial, passed: boolean) => {
    if (trial.timer != null) clearTimeout(trial.timer);
    trial.timer = null;
    if (!trial.running) return;
    trial.running = false;
    options.end(trial.kind.pluginId, trial.kind.kindId, passed).catch(() => {});
  };
  // The pass clock runs only once the trial began and the kind drew.
  const arm = (trial: Trial) => {
    if (trial.running && trial.ready && trial.timer == null) {
      trial.timer = setTimeout(() => finish(trial, true), TRIAL_MS);
    }
  };
  const open = () => {
    if (target || disposed) return;
    target = options.target();
    target?.addEventListener("webglcontextlost", onLost);
  };
  const close = () => {
    if (!target) return;
    target.removeEventListener("webglcontextlost", onLost);
    target.release();
    target = null;
  };

  /** The kinds on a visible stage now; a new one begins its trial, a gone one ends it unpassed. */
  const set = (kinds: readonly TrialKind[]) => {
    if (disposed) return;
    const now = new Map(kinds.map((k) => [k.kind as string, k]));
    for (const [key, trial] of trials) {
      if (now.has(key)) continue;
      trials.delete(key);
      finish(trial, false);
    }
    for (const { ready, ...kind } of kinds) {
      const known = trials.get(kind.kind);
      if (known) {
        known.ready = ready;
        arm(known);
        continue;
      }
      const trial: Trial = { kind, ready, running: false, timer: null };
      trials.set(kind.kind, trial);
      options.begin(kind.pluginId, kind.kindId).then(
        (began) => {
          if (!began || trials.get(kind.kind) !== trial) {
            if (began) options.end(kind.pluginId, kind.kindId, false).catch(() => {});
            return;
          }
          trial.running = true;
          arm(trial);
        },
        () => {},
      );
    }
    refresh();
  };
  // The context stays open while any trial or offscreen mount is live.
  const refresh = () => {
    if (trials.size > 0 || offscreens.size > 0) open();
    else close();
  };

  /** Lays a loss on `kind` while a short-lived offscreen mount of it lives; the release ends that. */
  const offscreen = (kind: ResetKind): (() => void) => {
    if (disposed) return () => {};
    const entry = { kind };
    offscreens.add(entry);
    open();
    return () => {
      if (offscreens.delete(entry)) refresh();
    };
  };

  const dispose = () => {
    set([]);
    offscreens.clear();
    close();
    disposed = true;
  };

  return { set, offscreen, dispose };
}

function webglTarget(): LossTarget | null {
  const canvas = document.createElement("canvas");
  canvas.width = 1;
  canvas.height = 1;
  const gl = canvas.getContext("webgl");
  if (!gl) return null;
  return {
    addEventListener: (type, listener) => canvas.addEventListener(type, listener),
    removeEventListener: (type, listener) => canvas.removeEventListener(type, listener),
    release: () => gl.getExtension("WEBGL_lose_context")?.loseContext(),
  };
}

export type ResetSentinel = ReturnType<typeof createResetSentinel>;

// The sentinel the shell runs, so offscreen mounts anywhere reach it.
let shell: ResetSentinel | null = null;

/** Lays a loss during a short-lived offscreen mount on its kind; a no-op without a shell. */
export function watchOffscreen(kind: ResetKind): () => void {
  return shell ? shell.offscreen(kind) : () => {};
}

/** Runs the sentinel over the kinds on a visible stage, laying a loss inside trials on `onLoss`. */
export function useResetSentinel(kinds: readonly TrialKind[], onLoss: (kinds: ResetKind[]) => void): void {
  const lossRef = useRef(onLoss);
  lossRef.current = onLoss;
  const sentinel = useRef<ReturnType<typeof createResetSentinel> | null>(null);

  useEffect(() => {
    const made = createResetSentinel({
      begin: pluginVisTrialBegin,
      end: pluginVisTrialEnd,
      onLoss: (lost) => lossRef.current(lost),
      target: webglTarget,
    });
    sentinel.current = made;
    shell = made;
    return () => {
      made.dispose();
      sentinel.current = null;
      if (shell === made) shell = null;
    };
  }, []);

  useEffect(() => {
    sentinel.current?.set(kinds);
  }, [kinds]);
}
