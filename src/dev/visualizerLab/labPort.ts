/*
 * The lab's `port` mode: draws the still of each plugin fixture through the committed runtime bundle, the
 * way a plugin frame does, and returns the same rows as `hash` so the two outputs diff with
 * tools/visualizer-hash-diff.mjs. Each row loads a fresh copy of the bundle against a stand-in window, so
 * its init message goes to that copy alone. The runtime serves the still as a bitmap; the pixels are read
 * from the canvas it snapshots, in the task that draws them, because a bitmap would round-trip the
 * premultiplied framebuffer. The runtime's rest frame says the track is paused where the lab frame says
 * playing, so the registered kind is drawn with `playing` held true.
 */

// -- Local Imports --
import { readPixels, sha256 } from "./labPixels";
import {
  LAB_LAYOUTS,
  applyTheme,
  labFrame,
  reseed,
  sceneTheme,
  type LabLayoutId,
  type LabTheme,
} from "./labScene";
import { registryScene } from "../../components/player/visualizers/gl/registryScene";
import bundleSource from "../../../plugin-kit/visualizers/runtime/plisto-vis-1.js?raw";

// -- State Imports --
import { isDarkOnly, type GlKind, type VisualizerKind } from "../../state/player/visualizerKind";

// -- Type Imports --
import type { Candidate, Kit } from "../../components/player/visualizers/gl/kit";
import type { FrameMessage, VisInit } from "../../visRuntime/protocol";

const FIXTURES = import.meta.glob<string>("../../../plugin-kit/visualizers/fixtures/*.js", {
  query: "?raw",
  import: "default",
});

// A still that takes longer than this fails the row.
const STILL_TIMEOUT_MS = 120000;

interface Namespace {
  candidate: (factory: (kit: Kit) => Candidate, options?: unknown) => void;
  [name: string]: unknown;
}

export interface PortRow {
  kind: string;
  theme: string;
  layout: string;
  sha256: string;
}

export interface PortRun {
  kinds: string[];
  themes: LabTheme[];
  layouts: LabLayoutId[];
  cover: ImageBitmap;
}

/** The window a bundle copy sees: the real one, except its parent is itself and it hears its own messages. */
function standInWindow(): { stand: Window; deliver: (init: VisInit, port: MessagePort) => void } {
  let listener: ((e: MessageEvent) => void) | null = null;
  const stand: Window = new Proxy(window, {
    get(target, key) {
      if (key === "parent") return stand;
      if (key === "addEventListener") {
        return (_type: string, fn: (e: MessageEvent) => void) => {
          listener = fn;
        };
      }
      const value = Reflect.get(target, key);
      return typeof value === "function" ? value.bind(target) : value;
    },
  });
  return {
    stand,
    deliver(init, port) {
      if (!listener) throw new Error("the runtime registered no message listener");
      listener({ source: stand, data: init, ports: [port] } as unknown as MessageEvent);
    },
  };
}

/** Holds `playing` true for every frame the candidate is asked to draw. */
function pinPlaying(candidate: Candidate): Candidate {
  const draw = candidate.draw;
  candidate.draw = (f) => draw({ ...f, playing: true });
  return candidate;
}

/** The ink color token as sRGB in 0..1 under the current theme. */
function inkRgb(): [number, number, number] {
  const el = document.createElement("div");
  el.style.color = "var(--ink)";
  document.body.appendChild(el);
  const m = getComputedStyle(el).color.match(/[\d.]+/g);
  el.remove();
  return m && m.length >= 3 ? [Number(m[0]) / 255, Number(m[1]) / 255, Number(m[2]) / 255] : [0, 0, 0];
}

/** The framebuffer of a WebGL canvas or the pixels of a 2D one. */
function canvasBytes(canvas: HTMLCanvasElement): Uint8Array {
  if (canvas.getContext("webgl2")) return readPixels(canvas);
  const g = canvas.getContext("2d");
  if (!g) throw new Error("the snapshot canvas has no readable context");
  return new Uint8Array(g.getImageData(0, 0, canvas.width, canvas.height).data.buffer);
}

function initFor(kind: string, theme: LabTheme, layout: LabLayoutId, cover: ImageBitmap): VisInit {
  const frame = labFrame(theme, layout, cover);
  const traits = kind === "ridge" ? null : registryScene(kind as GlKind).descriptor;
  const { id: _id, ...stage } = LAB_LAYOUTS[layout];
  return {
    plisto: 1,
    type: "plisto:vis-init",
    api: 1,
    kind,
    composite: traits?.composite ?? { light: "image", dark: "image" },
    fillsStage: traits?.fillsStage ?? true,
    needs: { fine: false, cover: false, pointer: false, waveform: false },
    settingShapes: [],
    context: {
      layout: stage,
      palette: frame.palette,
      cover: frame.cover,
      colors: { ground: frame.ground, backing: frame.backing, ink: inkRgb() },
      light: frame.light,
      reactivity: "balanced",
      ambient: frame.ambient,
      reducedMotion: false,
      settings: {},
    },
  };
}

/** Mounts one fixture and returns the pixels of its still. */
async function drawStill(source: string, init: VisInit): Promise<Uint8Array> {
  const { stand, deliver } = standInWindow();
  const ns = new Function("window", `${bundleSource}\nreturn plistoVis;`)(stand) as Namespace;
  const api: Namespace = {
    ...ns,
    candidate: (factory, options) => ns.candidate((kit) => pinPlaying(factory(kit)), options),
  };
  new Function("plistoVis", source)(api);

  let pixels: Uint8Array | null = null;
  const realSnapshot = window.createImageBitmap;
  window.createImageBitmap = ((image: ImageBitmapSource, ...rest: unknown[]) => {
    if (image instanceof HTMLCanvasElement) pixels = canvasBytes(image);
    return (realSnapshot as (...a: unknown[]) => Promise<ImageBitmap>).call(window, image, ...rest);
  }) as typeof window.createImageBitmap;

  const { port1, port2 } = new MessageChannel();
  try {
    const answered = new Promise<FrameMessage>((resolve, reject) => {
      const timer = window.setTimeout(
        () => reject(new Error(`no still within ${STILL_TIMEOUT_MS} ms`)),
        STILL_TIMEOUT_MS,
      );
      port1.onmessage = (e: MessageEvent<FrameMessage>) => {
        const m = e.data;
        if (m.type === "still" || m.type === "error" || m.type === "lost") {
          window.clearTimeout(timer);
          resolve(m);
        }
      };
    });
    reseed();
    deliver(init, port2);
    port1.postMessage({ type: "still", id: 1 });
    const message = await answered;
    if (message.type === "still" && message.bitmap) message.bitmap.close();
    if (message.type === "error") throw new Error(`${init.kind}: ${message.stage}: ${message.message}`);
    if (message.type === "lost") throw new Error(`${init.kind}: the context was lost`);
    if (message.type === "still" && message.error) throw new Error(`${init.kind}: ${message.error}`);
    if (!pixels) throw new Error(`${init.kind}: the runtime took no snapshot`);
    return pixels;
  } finally {
    port1.postMessage({ type: "dispose" });
    port1.close();
    window.createImageBitmap = realSnapshot;
  }
}

/** The rows of `hash`, drawn through the runtime from the fixtures. */
export async function runPort(run: PortRun): Promise<PortRow[]> {
  const rows: PortRow[] = [];
  for (const kind of run.kinds) {
    const load = FIXTURES[`../../../plugin-kit/visualizers/fixtures/${kind}.js`];
    if (!load) throw new Error(`no fixture for ${kind}`);
    const source = await load();
    for (const theme of run.themes) {
      const drawn = sceneTheme(isDarkOnly(kind as VisualizerKind), theme);
      applyTheme(drawn);
      for (const layout of run.layouts) {
        const bytes = await drawStill(source, initFor(kind, drawn, layout, run.cover));
        rows.push({ kind, theme, layout, sha256: await sha256(bytes) });
      }
    }
  }
  return rows;
}
