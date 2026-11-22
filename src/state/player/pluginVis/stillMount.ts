/*
 * A short-lived mount that asks a plugin kind for one still and goes away. The frame is mapped as a
 * visualizer, sent init and one still request, and removed once the outcome is known. It never takes part
 * in the stage's bookkeeping: it is not listed as a stage frame, so the nets neither watch it nor count it
 * as shown and it is never ticked. While it lives the reset sentinel listens on its behalf, in memory
 * only. The runtime serves a still only before its first tick, which is why no tick is ever sent.
 *
 * The runtime answers a pending still with an empty one before it reports an error, so an empty still
 * reads as "none" only after the frame reported ready and no error followed within a grace period. The
 * mount keeps its own clocks from the moment it is asked for, url request included: the slow mark runs
 * until the outcome, whatever the frame says, and the time limit until the frame reports ready.
 */

// -- State Imports --
import { attachFrame, detachFrame, frameLoaded } from "../../plugins/pluginHost";
import { leaveCrumb } from "./offscreenCrumbs";
import { createStageMount, GIVE_UP_MS, SLOW_MS, type StageMount, type StagePhase } from "./stageMount";
import { watchOffscreen, type ResetKind } from "./useResetSentinel";

// -- IPC Imports --
import { pluginVisUrl } from "../../../lib/ipc";

// -- Type Imports --
import type { FrameWindow } from "../../plugins/pluginHost";
import type { VisContext } from "../../../visRuntime/protocol";
import type { PluginVisualizerDescriptor } from "../pluginVisualizers";

/** How long an empty still waits for an error before it reads as "none". */
export const NONE_GRACE_MS = 250;
/** How long a frame that reported ready may take to answer the still request. */
export const ANSWER_MS = 10_000;

/** The hidden frame of a still mount. */
export interface StillFrame {
  window: FrameWindow;
  // Starts the frame loading `url`; `onLoad` runs on each load of its document.
  load: (url: string, onLoad: () => void) => void;
  remove: () => void;
}

/** What a still mount touches outside itself; the defaults are the app's. */
export interface StillEnv {
  url: (pluginId: string, kindId: string) => Promise<string>;
  frame: (width: number, height: number) => StillFrame;
  attach: (mountKey: string, pluginId: string, window: FrameWindow) => void;
  detach: (mountKey: string) => void;
  loaded: (mountKey: string) => "first" | "again";
  // Lays a graphics reset or a crash during the mount on the kind; the release stops that.
  watch: (kind: ResetKind) => () => void;
}

/**
 * How a still mount ended: a still, none because the kind gives none, a failure (`failed` after the frame
 * reported an error, `dropped` for a refusal, a second load, a refused url or a time limit), or a cancel.
 */
export type StillOutcome =
  | { type: "still"; bitmap: ImageBitmap }
  | { type: "none" }
  | { type: "failed"; phase: "failed" | "dropped" }
  | { type: "cancelled" };

export interface StillRender {
  result: Promise<StillOutcome>;
  // Ends the mount early; the result settles cancelled.
  cancel: () => void;
}

export interface StillOptions {
  env?: StillEnv;
  // The mount's phase as it changes; `slow` comes from the mount's own slow mark.
  onPhase?: (phase: StagePhase) => void;
}

const STILL_ID = 1;
let serial = 0;

// Without ImageBitmap, as under tests, any still passes.
const isBitmap = (bitmap: unknown) =>
  typeof ImageBitmap === "undefined" || bitmap instanceof ImageBitmap;

/** Watches a mount for a graphics reset while the page lives and for a crash at the next launch. */
export function watchMount(kind: ResetKind): () => void {
  const crumb = leaveCrumb(kind.pluginId, kind.kindId);
  const sentinel = watchOffscreen(kind);
  return () => {
    sentinel();
    crumb();
  };
}

/** A frame in the page, out of sight and out of reach, sized like the stage it draws. */
function pageFrame(width: number, height: number): StillFrame {
  const el = document.createElement("iframe");
  el.setAttribute("sandbox", "allow-scripts");
  el.setAttribute("allow", "");
  el.setAttribute("aria-hidden", "true");
  el.referrerPolicy = "strict-origin";
  el.tabIndex = -1;
  Object.assign(el.style, {
    position: "fixed",
    left: "0",
    top: "0",
    width: `${width}px`,
    height: `${height}px`,
    border: "0",
    opacity: "0",
    pointerEvents: "none",
    zIndex: "-1",
    colorScheme: "normal",
  });
  document.body.appendChild(el);
  return {
    window: el.contentWindow as FrameWindow,
    load(url, onLoad) {
      el.onload = onLoad;
      el.src = url;
    },
    remove: () => el.remove(),
  };
}

const pageEnv: StillEnv = {
  url: pluginVisUrl,
  frame: pageFrame,
  attach: (mountKey, pluginId, window) => attachFrame(mountKey, pluginId, window, "visualizer"),
  detach: detachFrame,
  loaded: frameLoaded,
  watch: watchMount,
};

/** Mounts the kind once under `context` and resolves with its still. */
export function renderPluginStill(
  descriptor: PluginVisualizerDescriptor,
  context: VisContext,
  options: StillOptions = {},
): StillRender {
  const env = options.env ?? pageEnv;
  const mountKey = `vis|still|${descriptor.id}|${descriptor.version}|${descriptor.manifestHash}|${++serial}`;
  let frame: StillFrame | null = null;
  let mount: StageMount | null = null;
  let done = false;
  let ready = false;
  // An empty still came in; ready, or an error, decides what it means.
  let empty = false;
  let timer: ReturnType<typeof setTimeout> | null = null;
  let settle!: (outcome: StillOutcome) => void;
  const result = new Promise<StillOutcome>((resolve) => {
    settle = resolve;
  });
  const release = env.watch({
    kind: descriptor.id,
    pluginId: descriptor.pluginId,
    kindId: descriptor.kindId,
  });

  const finish = (outcome: StillOutcome) => {
    if (done) {
      if (outcome.type === "still") outcome.bitmap.close();
      return;
    }
    done = true;
    if (timer != null) clearTimeout(timer);
    clearTimeout(slowTimer);
    clearTimeout(limitTimer);
    mount?.dispose();
    if (frame) {
      env.detach(mountKey);
      frame.remove();
    }
    release();
    settle(outcome);
  };
  const failed = (phase: "failed" | "dropped") => finish({ type: "failed", phase });
  const wait = (ms: number, then: () => void) => {
    if (timer != null) clearTimeout(timer);
    timer = setTimeout(then, ms);
  };
  // After ready: an empty still settles none once the grace passes; otherwise the answer has its limit.
  const afterReady = () => {
    if (empty) wait(NONE_GRACE_MS, () => finish({ type: "none" }));
    else wait(ANSWER_MS, () => failed("dropped"));
  };
  // Started before the url request: the slow mark runs until the outcome, the time limit until ready.
  const slowTimer = setTimeout(() => options.onPhase?.("slow"), SLOW_MS);
  const limitTimer = setTimeout(() => failed("dropped"), GIVE_UP_MS);

  env
    .url(descriptor.pluginId, descriptor.kindId)
    .then((url) => {
      if (done) return;
      const opened = env.frame(context.layout.width, context.layout.height);
      frame = opened;
      env.attach(mountKey, descriptor.pluginId, opened.window);
      const started = createStageMount({
        descriptor,
        context: () => context,
        reactivity: () => context.reactivity,
        meter: () => false,
        onPhase: (phase) => {
          // The frame's own slow mark stops at ready, so the mount's stands in for it.
          if (phase !== "slow") options.onPhase?.(phase);
          if (phase === "dropped" || phase === "failed") failed(phase);
          if (phase === "ready" && !ready) {
            ready = true;
            clearTimeout(limitTimer);
            afterReady();
          }
        },
        onFail: () => failed("failed"),
        onStill: (_id, bitmap, error) => {
          if (bitmap) {
            if (isBitmap(bitmap)) finish({ type: "still", bitmap });
            else failed("failed");
          }
          else if (error) failed("dropped");
          else if (!empty) {
            empty = true;
            if (ready) afterReady();
          }
        },
      });
      mount = started;
      opened.load(url, () => {
        if (done) return;
        if (env.loaded(mountKey) === "again") {
          failed("dropped");
          return;
        }
        started.start((init, port) => opened.window.postMessage(init, "*", [port]));
        started.requestStill(STILL_ID);
      });
    })
    .catch(() => failed("dropped"));

  return { result, cancel: () => finish({ type: "cancelled" }) };
}
