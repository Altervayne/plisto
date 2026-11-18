/*
 * The lab's thumbnail mode: each GL kind drawn in full flow through the real renderer, and the Canvas 2D
 * ridge drawn by its real component, fed the simulated groove through the app's own spectrum listeners.
 * Both are composed on the ambient ground with the cover tile on top and scaled to the picker's size.
 */

// -- Framework Imports --
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";

// -- Component Imports --
import { SpectrumRidge } from "../../components/player/SpectrumRidge";

// -- Hook Imports --
import { useSpectrumSync } from "../../state/player/spectrum";

// -- Local Imports --
import { createRenderer } from "../../components/player/visualizers/gl/renderer";
import { COMPOSITE_OP, rgbCss } from "./labCompose";
import { createLabMusic } from "./labMusic";
import { blendOf, darkOnlyOf, resolverWith, type LabScene } from "./labSceneModule";
import {
  applyTheme,
  coverPixels,
  groundOf,
  labFrame,
  paintCover,
  reseed,
  sceneTheme,
  setDpr,
  THUMB_LAYOUT,
  type LabTheme,
} from "./labScene";

// -- State Imports --
import { needsFineSpectrum, type VisualizerKind } from "../../state/player/visualizerKind";

// The thumbnail size: the 170 px tile at 2x.
const THUMB_W = 340;
const THUMB_H = 212;
const THUMB_QUALITY = 0.85;
// The groove starts in its intro and runs this many 60 fps frames before the grab.
const THUMB_START = 7;
const THUMB_FRAMES = 360;

/** The thumbnail frame: the ground, the kind's layer drawn by `paint`, the cover tile on top, scaled down. */
function composeThumb(ground: [number, number, number], paint: (x: CanvasRenderingContext2D) => void): string {
  const layout = THUMB_LAYOUT;
  const full = document.createElement("canvas");
  full.width = layout.width;
  full.height = layout.height;
  const x = full.getContext("2d");
  if (!x) throw new Error("2d context unavailable");
  x.fillStyle = rgbCss(ground);
  x.fillRect(0, 0, full.width, full.height);
  paint(x);
  x.globalCompositeOperation = "source-over";
  const [cx, cy, cw, ch] = layout.cover;
  x.save();
  x.beginPath();
  x.roundRect(cx, cy, cw, ch, layout.radius);
  x.clip();
  x.drawImage(paintCover(512), cx, cy, cw, ch);
  x.restore();

  const thumb = document.createElement("canvas");
  thumb.width = THUMB_W;
  thumb.height = THUMB_H;
  const t = thumb.getContext("2d");
  if (!t) throw new Error("2d context unavailable");
  t.imageSmoothingQuality = "high";
  t.drawImage(full, 0, 0, THUMB_W, THUMB_H);
  return thumb.toDataURL("image/webp", THUMB_QUALITY);
}

/** One GL kind drawn in full flow: the groove runs for a few seconds so trails, rings and spectra develop. */
function glThumb(scene: LabScene | null, kind: string, theme: LabTheme, cover: ImageBitmap): string {
  const canvas = document.createElement("canvas");
  const renderer = createRenderer(canvas, resolverWith(scene));
  if (!renderer) throw new Error("WebGL2 unavailable");
  renderer.fit(THUMB_LAYOUT);
  reseed();
  const base = labFrame(theme, "ambient", cover);
  const music = createLabMusic(THUMB_START);
  for (let i = 0; i < THUMB_FRAMES; i++) {
    const m = music.step(1 / 60);
    const fine = needsFineSpectrum(kind as VisualizerKind) ? m.fine : null;
    renderer.render(kind, { ...base, sig: m.sig, fine, t: THUMB_START + i / 60, dt: 1 / 60, still: false });
  }
  const url = composeThumb(base.ground, (x) => {
    x.globalCompositeOperation = COMPOSITE_OP[blendOf(scene, kind, base.light)];
    x.drawImage(canvas, 0, 0);
  });
  renderer.dispose();
  return url;
}

/** Stands in for the Tauri bridge so the app's own spectrum listeners can be fed from the lab. */
function installBridge(): (event: string, payload: unknown) => void {
  const handlers = new Map<string, number[]>();
  let next = 1;
  const w = window as unknown as Record<string, unknown>;
  w.__TAURI_INTERNALS__ = {
    transformCallback: (cb: (e: unknown) => void) => {
      const id = next++;
      w[`_${id}`] = cb;
      return id;
    },
    invoke: async (cmd: string, args: { event?: string; handler?: number }) => {
      if (cmd === "plugin:event|listen" && args.event && args.handler) {
        handlers.set(args.event, [...(handlers.get(args.event) ?? []), args.handler]);
      }
      return next++;
    },
  };
  w.__TAURI_EVENT_PLUGIN_INTERNALS__ = { unregisterListener: () => {} };
  return (event, payload) => {
    for (const id of handlers.get(event) ?? []) (w[`_${id}`] as (e: unknown) => void)({ event, id, payload });
  };
}

function SpectrumFeed() {
  useSpectrumSync();
  return null;
}

/** Swaps requestAnimationFrame for a queue the lab pumps by hand, so frames run at a fixed 60 fps. */
function manualFrames(): { pump: (frame: number) => void; restore: () => void } {
  const raf = window.requestAnimationFrame;
  const caf = window.cancelAnimationFrame;
  let queue = new Map<number, FrameRequestCallback>();
  let id = 0;
  window.requestAnimationFrame = (cb) => {
    queue.set(++id, cb);
    return id;
  };
  window.cancelAnimationFrame = (handle) => {
    queue.delete(handle);
  };
  return {
    pump(frame) {
      const due = queue;
      queue = new Map();
      for (const cb of due.values()) cb((frame * 1000) / 60);
    },
    restore() {
      window.requestAnimationFrame = raf;
      window.cancelAnimationFrame = caf;
    },
  };
}

/** The cover glow the app lays under the ridge: the cover palette as soft radial washes around the tile. */
function paintGlow(x: CanvasRenderingContext2D, theme: LabTheme): void {
  const { width, height } = THUMB_LAYOUT;
  const washes: [string, number, number][] = [
    ["224,100,79", 0.7, 0.78],
    ["42,138,160", 0.3, 0.7],
    ["246,201,138", 0.5, 0.95],
  ];
  const alpha = theme === "light" ? 0.7 : 0.55;
  for (const [rgb, fx, fy] of washes) {
    const g = x.createRadialGradient(width * fx, height * fy, 0, width * fx, height * fy, height * 0.75);
    g.addColorStop(0, `rgba(${rgb},${alpha})`);
    g.addColorStop(1, `rgba(${rgb},0)`);
    x.fillStyle = g;
    x.fillRect(0, 0, width, height);
  }
}

/**
 * The real SpectrumRidge on the stage, composited soft-light, fed the simulated groove through the app's
 * own spectrum listeners and its own animation loop.
 */
async function ridgeThumb(theme: LabTheme): Promise<string> {
  const layout = THUMB_LAYOUT;
  const emit = installBridge();
  const stage = document.createElement("div");
  stage.style.cssText = `position:relative;width:${layout.width}px;height:${layout.height}px`;
  document.body.appendChild(stage);
  const frames = manualFrames();
  const root = createRoot(stage);
  try {
    flushSync(() =>
      root.render(
        <>
          <SpectrumFeed />
          <SpectrumRidge tall />
        </>,
      ),
    );
    const music = createLabMusic(THUMB_START);
    for (let i = 0; i < THUMB_FRAMES; i++) {
      const m = music.step(1 / 60);
      if (i % 2 === 0) emit("player:spectrum", m.bands);
      frames.pump(i);
    }
    const canvas = stage.querySelector("canvas") as HTMLCanvasElement;
    const box = canvas.getBoundingClientRect();
    const origin = stage.getBoundingClientRect();
    return composeThumb(groundOf("ambient"), (x) => {
      paintGlow(x, theme);
      x.globalCompositeOperation = "soft-light";
      x.drawImage(canvas, box.left - origin.left, box.top - origin.top, box.width, box.height);
    });
  } finally {
    root.unmount();
    stage.remove();
    frames.restore();
  }
}

/** The thumbnails of `kinds` in each of `themes`; a kind with no light look is drawn dark in both. */
export async function runThumb(scene: LabScene | null, kinds: string[], themes: LabTheme[]) {
  const cover = await coverPixels();
  const rows: { kind: string; theme: string; dataUrl: string }[] = [];
  setDpr(1);
  for (const kind of kinds) {
    for (const theme of themes) {
      const drawn = kind === "ridge" ? theme : sceneTheme(darkOnlyOf(scene, kind), theme);
      applyTheme(drawn);
      rows.push({ kind, theme, dataUrl: kind === "ridge" ? await ridgeThumb(theme) : glThumb(scene, kind, drawn, cover) });
    }
  }
  return rows;
}
