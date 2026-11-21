/*
 * The plugin visualizer runtime, loaded by every plugin visualizer frame as the global `plistoVis`. A
 * kind registers once, through one of four forms: `shader`, `scene`, `candidate` or `raw`. The host's
 * init can arrive before or after that: one window listener holds it until a registration exists, and
 * on the served shader page the runtime registers the page's own source. Loading the script touches
 * nothing but that listener, so it evaluates anywhere; the namespace also carries the shader sources
 * and helpers the built-in kinds are written with, and a small bridge client. A later init replaces
 * the earlier one: its mount is disposed, or its port closed if it never mounted.
 */

// -- Local Imports --
import { BRIDGE_PROTOCOL, createBridgeClient } from "./bridgeClient";
import { candidateForm } from "./forms/candidate";
import { rawForm } from "./forms/raw";
import { sceneForm } from "./forms/scene";
import { shaderForm } from "./forms/shader";
import { errorText } from "./gate";
import { browserEnv, startMount, wrapPort } from "./lifecycle";
import { readInit, VIS_API } from "./protocol";
import { isShaderPage, loadShader } from "./shaderHost";

// -- Type Imports --
import type { CandidateOptions } from "./forms/candidate";
import type { SceneSpec } from "./forms/scene";
import type { ShaderSpec } from "./forms/shader";
import type { RawHandlers, Registration } from "./lifecycle";
import type { VisInit } from "./protocol";
import type { Candidate, Kit } from "../components/player/visualizers/gl/kit";

// -- Namespace: shader sources and helpers --
export { FS_VS, HUSH, HUSH_SLOTS, PRELUDE } from "../components/player/visualizers/gl/shaders";
export { createRings, FLUID_PRELUDE, RING_SLOTS, setFluid } from "../components/player/visualizers/gl/fluid";
export { clamp01, COZY_PRELUDE, createRng } from "../components/player/visualizers/gl/cozy";
export { createDots, DOT_FS, DOT_PRELUDE } from "../components/player/visualizers/gl/dots";
export { SCENE_PRELUDE, setScene } from "../components/player/visualizers/gl/scene";
export {
  createCyberBeat,
  CYBER_KIT,
  cyberBandMean,
  cyberBands,
  cyberBeat,
  cyberGain,
} from "../components/player/visualizers/gl/cyber";
export { COSMIC_COMMON, cosmicPunch, createCosmicPunch } from "../components/player/visualizers/gl/cosmic";
export { createCoverTexture } from "../components/player/visualizers/gl/coverTexture";
export { createBeatClock, stepBeatClock } from "../components/player/visualizers/gl/beatClock";
export {
  admitBeat,
  BEAT_MAX_PER_SEC,
  BEAT_MIN_GAP_SECS,
  easeEnvelope,
  LEVEL_TAU,
  MOTION_ATTACK_SECS,
  motionEnvelope,
  REACTIVITY_PROFILES,
  restingBands,
  restSignal,
  SWELL_TAU,
} from "../state/player/visualSignal";
export { smoothBands } from "../state/player/smoothBands";
export { BAND_COUNT, FINE_BAND_COUNT } from "../types";
export { settingUniform } from "./forms/shader";

/** The visualizer api this runtime serves. */
export const version = VIS_API;

let registration: Registration | null = null;
let waiting: { init: VisInit; port: MessagePort } | null = null;
let mounted: { dispose: () => void } | null = null;

const bridge = createBridgeClient((msg) => window.parent.postMessage(msg, "*"));

/** Calls a host method over the plugin bridge. */
export const call = bridge.call;
export const log = bridge.log;
export const storage = bridge.storage;

// The init being served; one that a later init replaced is dropped when its shader arrives.
let current = 0;

const refuse = (port: MessagePort, message: string) => {
  const visPort = wrapPort(port);
  visPort.post({ type: "error", stage: "setup", message });
  visPort.close();
};

function start(init: VisInit, port: MessagePort, reg: Registration): void {
  try {
    mounted = startMount(init, wrapPort(port), reg(init), browserEnv());
  } catch (e) {
    refuse(port, errorText(e));
  }
}

function onInit(init: VisInit, port: MessagePort): void {
  const own = ++current;
  mounted?.dispose();
  mounted = null;
  waiting?.port.close();
  waiting = null;
  if (init.api !== VIS_API) {
    refuse(port, `runtime api ${VIS_API} cannot serve api ${init.api}`);
    return;
  }
  if (registration) {
    start(init, port, registration);
  } else if (isShaderPage(location.pathname)) {
    loadShader(location.href, (url) => fetch(url)).then(
      (reg) => {
        if (!registration) registration = reg;
        if (own === current) start(init, port, registration);
        else port.close();
      },
      (e) => refuse(port, errorText(e)),
    );
  } else {
    waiting = { init, port };
  }
}

function register(reg: Registration): void {
  if (registration) throw new Error("a visualizer frame registers one kind");
  registration = reg;
  if (waiting) {
    const { init, port } = waiting;
    waiting = null;
    start(init, port, reg);
  }
}

/** Registers a fragment shader kind. */
export function shader(spec: ShaderSpec): void {
  register(shaderForm(spec));
}

/** Registers a kind of one or more full-screen passes. */
export function scene<S>(spec: SceneSpec<S>): void {
  register(sceneForm(spec));
}

/** Registers a kind written as a factory over the kit, the way the built-in kinds are. */
export function candidate(factory: (kit: Kit) => Candidate, options?: CandidateOptions): void {
  register(candidateForm(factory, options));
}

/** Registers a kind that draws itself. */
export function raw(handlers: RawHandlers): void {
  register(rawForm(handlers));
}

if (typeof window !== "undefined" && typeof window.addEventListener === "function") {
  window.addEventListener("message", (event: MessageEvent) => {
    if (event.source !== window.parent) return;
    const init = readInit(event.data);
    if (init) {
      if (event.ports[0]) onInit(init, event.ports[0]);
      return;
    }
    const data = event.data as Record<string, unknown> | null;
    if (data && typeof data === "object" && data.plisto === BRIDGE_PROTOCOL) bridge.handle(data);
  });
}
