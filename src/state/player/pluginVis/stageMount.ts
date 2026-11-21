/*
 * One plugin visualizer mount on a stage, off React: the port and its transport, the feed, the slot's
 * visibility and the context sync, plus the clock that decides how long a compiling frame may take. A
 * frame without `ready` at the slow mark is not a fault: the stage shows the fallback while it compiles
 * on, and a `ready` before the limit swaps it in late. Past the limit the mount ends with no fault mark.
 */

// -- Local Imports --
import {
  VIS_API,
  VIS_INIT_TYPE,
  type VisContext,
  type VisInit,
  type VisPointer,
} from "../../../visRuntime/protocol";
import { createContextSync } from "./contextDiff";
import { createFeed, liveSources, type Feed, type FeedSources } from "./feed";
import { createTransport, type HostPort, type Transport, type TransportStats } from "./transport";
import { createVisibilityState, type VisibilityInputs } from "./visibility";

// -- Type Imports --
import type { PluginVisualizerDescriptor } from "../pluginVisualizers";
import type { Reactivity } from "../visualizerKind";

/** Where a mount stands: compiling, compiling past the slow mark, drawing, given up on, or failed. */
export type StagePhase = "mounting" | "slow" | "ready" | "dropped" | "failed";

/** A frame still without `ready` at this point gives the stage over to the fallback. */
export const SLOW_MS = 3000;
/** A frame still without `ready` at this point is torn down. */
export const GIVE_UP_MS = 30_000;

/** The two ends of a mount's channel: the host keeps one, the frame's end travels with init. */
export interface StageChannel {
  host: HostPort;
  frame: Transferable;
}

export interface StageMountOptions {
  descriptor: PluginVisualizerDescriptor;
  // The context as of now; read at init and on every sync.
  context: () => VisContext;
  reactivity: () => Reactivity;
  onPhase: (phase: StagePhase) => void;
  // The frame reported an error or lost its context.
  onFail: () => void;
  // The pointer over the stage; read only when the kind asks for it.
  pointer?: () => VisPointer | null;
  sources?: FeedSources;
  channel?: () => StageChannel;
}

export interface StageMount {
  // Opens the channel and hands init and the frame's end of it to `post`. Runs once.
  start: (post: (init: VisInit, port: Transferable) => void) => void;
  // One display frame: steps the feed and offers its tick, which the transport withholds while hidden.
  step: (nowMs: number) => void;
  // Sends the context fields that changed since the last sync.
  sync: () => void;
  setInputs: (patch: Partial<VisibilityInputs>) => void;
  phase: () => StagePhase;
  visible: () => boolean;
  // Null until started.
  stats: () => TransportStats | null;
  // Gives the mount up with no fault mark, as the limit does.
  end: () => void;
  dispose: () => void;
}

/** A MessagePort as the transport's port. */
export function hostPortOf(port: MessagePort): HostPort {
  let handler: HostPort["onmessage"] = null;
  return {
    postMessage: (message) => port.postMessage(message),
    close: () => port.close(),
    get onmessage() {
      return handler;
    },
    set onmessage(next) {
      handler = next;
      port.onmessage = next ? (event) => next(event) : null;
    },
  };
}

function messageChannel(): StageChannel {
  const { port1, port2 } = new MessageChannel();
  return { host: hostPortOf(port1), frame: port2 };
}

/** The init for a kind: its look, needs and setting shapes, at the declared setting defaults. */
export function stageInit(descriptor: PluginVisualizerDescriptor, context: VisContext): VisInit {
  return {
    plisto: 1,
    type: VIS_INIT_TYPE,
    api: VIS_API,
    kind: descriptor.kindId,
    composite: { light: descriptor.look.light.composite, dark: descriptor.look.dark.composite },
    fillsStage: descriptor.fillsStage,
    needs: { ...descriptor.needs },
    settingShapes: descriptor.settings.map((s) =>
      s.type === "choice"
        ? { id: s.id, type: s.type, options: s.options.map((o) => o.id) }
        : { id: s.id, type: s.type },
    ),
    meter: false,
    context,
  };
}

/** The declared default of each setting, by id. */
export function defaultSettings(descriptor: PluginVisualizerDescriptor): VisContext["settings"] {
  return Object.fromEntries(descriptor.settings.map((s) => [s.id, s.default]));
}

/** Starts the slow and give-up clocks at once; nothing is posted until `start`. */
export function createStageMount(options: StageMountOptions): StageMount {
  const { descriptor, context, onPhase, onFail } = options;
  const live = options.sources ?? liveSources;
  const pointer = options.pointer;
  const sources: FeedSources = descriptor.needs.pointer && pointer ? { ...live, pointer } : live;
  const feed: Feed = createFeed({ needs: descriptor.needs, reactivity: options.reactivity, sources });
  const view = createVisibilityState({}, (visible) => feed.setVisible(visible));
  let phase: StagePhase = "mounting";
  let transport: Transport | null = null;
  let contextSync: ReturnType<typeof createContextSync> | null = null;
  let ended = false;

  const release = () => {
    clearTimeout(slowTimer);
    clearTimeout(giveUpTimer);
    transport?.dispose();
    feed.dispose();
  };
  const enter = (next: StagePhase) => {
    if (ended || phase === next) return;
    phase = next;
    if (next === "ready") {
      clearTimeout(slowTimer);
      clearTimeout(giveUpTimer);
      view.set({ mounting: false });
    }
    if (next === "dropped" || next === "failed") {
      ended = true;
      release();
    }
    onPhase(next);
  };

  const slowTimer = setTimeout(() => enter("slow"), SLOW_MS);
  const giveUpTimer = setTimeout(() => enter("dropped"), GIVE_UP_MS);

  return {
    start(post) {
      if (transport || ended) return;
      const channel = (options.channel ?? messageChannel)();
      transport = createTransport({
        port: channel.host,
        isVisible: view.visible,
        onFrameMessage: (message) => {
          if (message.type === "ready") enter("ready");
          if ((message.type === "error" || message.type === "lost") && !ended) {
            enter("failed");
            onFail();
          }
        },
      });
      const initial = context();
      const sent = transport;
      contextSync = createContextSync(initial, (message) => sent.post(message));
      post(stageInit(descriptor, initial), channel.frame);
    },
    step(nowMs) {
      if (ended) return;
      const tick = feed.step(nowMs);
      transport?.offer(tick);
    },
    sync() {
      if (!ended) contextSync?.push(context());
    },
    setInputs: (patch) => view.set(patch),
    phase: () => phase,
    visible: view.visible,
    stats: () => transport?.stats() ?? null,
    end: () => enter("dropped"),
    dispose() {
      if (ended) return;
      ended = true;
      release();
    },
  };
}
