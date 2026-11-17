/*
 * The visualizer render lab. A dev-only page that draws the GL kinds through the real renderer from a
 * fixed scene. Query params: mode=view|hash|thumb|bench|flash|steps|level|calm, kind (one GL kind; absent
 * means all of them, except view, which takes glass), scene=<id> (a scene module the registry does not
 * hold, drawn in place of kind; dark=1 marks it dark-only), theme=light|dark and layout=player|ambient
 * (absent means both for hash and the measures). Every non-view mode writes its result as JSON into
 * <pre id="out"> and sets body[data-done]. Thumb mode also takes kind=ridge: the Canvas 2D ridge, drawn by
 * its real component.
 *
 * Measures: steps (brightness steps over the song's drop), flash (with kind or scene: WCAG flashes over the
 * drop, red=0|1 to force the red check; with neither: Fireflies' worst case), level (level=0..1, the
 * brightness a motion signal at its cap adds) and calm (the Calm rule). bench takes ref=<kind> to time the
 * kinds under the song's drop with the track playing, as a ratio to that kind.
 */

// -- Framework Imports --
import { flushSync } from "react-dom";
import { createRoot } from "react-dom/client";

// -- Component Imports --
import { SpectrumRidge } from "../../components/player/SpectrumRidge";

// -- Hook Imports --
import { useSpectrumSync } from "../../state/player/spectrum";

// -- Local Imports --
import { fireflyProbe } from "../../components/player/visualizers/gl/fireflies";
import { blendModeFor, createRenderer, type Renderer } from "../../components/player/visualizers/gl/renderer";
import {
  LAB_LAYOUTS,
  LAB_T,
  applyTheme,
  coverPixels,
  groundOf,
  labFrame,
  paintCover,
  reseed,
  sceneTheme,
  setDpr,
  THUMB_LAYOUT,
  withSeededRandom,
  type LabLayoutId,
  type LabTheme,
} from "./labScene";
import { createLabMusic } from "./labMusic";
import { DROP_START, createLabSong } from "./labSong";
import { runCalm, runDropFlash, runLevel, runSteps, type Probe } from "./labMeasure";
import { readPixels, relativeLuminance, round, sha256, worstWindow } from "./labPixels";
import { loadScene, resolverWith, type LabScene } from "./labSceneModule";

// -- State Imports --
import {
  VISUALIZER_KINDS,
  isDarkOnly,
  isGlKind,
  needsFineSpectrum,
  type GlKind,
  type VisualizerKind,
} from "../../state/player/visualizerKind";

// -- Type Imports --
import type { VisualSignal } from "../../state/player/visualSignal";

// -- Style Imports --
import "../../styles/tokens.css";
import "../../styles/base.css";

const THEMES: LabTheme[] = ["light", "dark"];
const LAYOUTS: LabLayoutId[] = ["player", "ambient"];
const GL_KINDS = VISUALIZER_KINDS.filter(isGlKind);

// The thumbnail size: the 170 px tile at 2x.
const THUMB_W = 340;
const THUMB_H = 212;
const THUMB_QUALITY = 0.85;
// The groove starts in its intro and runs this many 60 fps frames before the grab.
const THUMB_START = 7;
const THUMB_FRAMES = 360;

// Bench: warm-up renders absorb the shader compiles, then the timed run is amortized over one sync.
const BENCH_WARM = 10;
const BENCH_RUNS = 60;
const BENCH_DPRS = [1, 2];

const COMPOSITE_OP: Record<string, GlobalCompositeOperation> = {
  screen: "screen",
  multiply: "multiply",
  normal: "source-over",
};

const params = new URLSearchParams(location.search);

// The unregistered scene a run draws in place of a registered kind, when scene= names one.
let scene: LabScene | null = null;

function pickKinds(fallback: readonly string[]): string[] {
  if (scene) return [scene.id];
  const raw = params.get("kind");
  if (!raw) return [...fallback];
  if (!(GL_KINDS as readonly string[]).includes(raw)) throw new Error(`unknown GL kind: ${raw}`);
  return [raw];
}

function pickThumbKinds(): string[] {
  if (scene) return [scene.id];
  return params.get("kind") === "ridge" ? ["ridge"] : params.get("kind") ? pickKinds(GL_KINDS) : ["ridge", ...GL_KINDS];
}

/** The blend a kind's layer takes over the stage: the scene's own, or the registry's. */
function blendOf(kind: string, light: boolean) {
  if (scene && kind === scene.id) return light ? scene.source.descriptor.blend.light : scene.source.descriptor.blend.dark;
  return blendModeFor(kind as GlKind, light);
}

/** Whether a kind has no light look, so the lab draws it in the dark theme. */
function darkOnlyOf(kind: string): boolean {
  return scene && kind === scene.id ? scene.darkOnly : isDarkOnly(kind as VisualizerKind);
}

function pickThemes(): LabTheme[] {
  const raw = params.get("theme");
  return raw === "light" || raw === "dark" ? [raw] : THEMES;
}

function pickLayouts(): LabLayoutId[] {
  const raw = params.get("layout");
  return raw === "player" || raw === "ambient" ? [raw] : LAYOUTS;
}

/** A renderer on its own canvas, fitted to a layout: a fresh one per render, so no state leaks between kinds. */
function open(layoutId: LabLayoutId): { canvas: HTMLCanvasElement; renderer: Renderer<string> } {
  const canvas = document.createElement("canvas");
  const renderer = createRenderer(canvas, resolverWith(scene));
  if (!renderer) throw new Error("WebGL2 unavailable");
  renderer.fit(LAB_LAYOUTS[layoutId]);
  return { canvas, renderer };
}

async function runHash() {
  const cover = await coverPixels();
  const rows: { kind: string; theme: string; layout: string; sha256: string }[] = [];
  setDpr(1);
  for (const kind of pickKinds(GL_KINDS)) {
    for (const theme of pickThemes()) {
      const drawn = sceneTheme(darkOnlyOf(kind), theme);
      applyTheme(drawn);
      for (const layout of pickLayouts()) {
        const { canvas, renderer } = open(layout);
        reseed();
        renderer.still(kind, labFrame(drawn, layout, cover));
        rows.push({ kind, theme, layout, sha256: await sha256(readPixels(canvas)) });
        renderer.dispose();
      }
    }
  }
  return rows;
}

/** The thumbnail frame: the ground, the kind's layer drawn by `paint`, the cover tile on top, scaled down. */
function composeThumb(ground: [number, number, number], paint: (x: CanvasRenderingContext2D) => void): string {
  const layout = THUMB_LAYOUT;
  const full = document.createElement("canvas");
  full.width = layout.width;
  full.height = layout.height;
  const x = full.getContext("2d");
  if (!x) throw new Error("2d context unavailable");
  const [r, g, b] = ground;
  x.fillStyle = `rgb(${Math.round(r * 255)},${Math.round(g * 255)},${Math.round(b * 255)})`;
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
function glThumb(kind: string, theme: LabTheme, cover: ImageBitmap): string {
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
    x.globalCompositeOperation = COMPOSITE_OP[blendOf(kind, base.light)];
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

async function runThumb() {
  const cover = await coverPixels();
  const rows: { kind: string; theme: string; dataUrl: string }[] = [];
  setDpr(1);
  for (const kind of pickThumbKinds()) {
    for (const theme of pickThemes()) {
      // A dark-only kind's light thumbnail is its dark one.
      const drawn = kind === "ridge" ? theme : sceneTheme(darkOnlyOf(kind), theme);
      applyTheme(drawn);
      rows.push({ kind, theme, dataUrl: kind === "ridge" ? await ridgeThumb(theme) : glThumb(kind, drawn, cover) });
    }
  }
  return rows;
}

/** A signal frame kept whole: the follower rewrites its own object and bands array on every step. */
function copySig(sig: VisualSignal): VisualSignal {
  return { ...sig, bands: Float32Array.from(sig.bands) };
}

/** The song's signal frame by frame at Lively from two seconds into the drop: warm-up frames, then the timed ones. */
function recordDrop(): VisualSignal[] {
  const song = createLabSong(0, "lively");
  const start = DROP_START + 2;
  const frames: VisualSignal[] = [];
  for (let t = 0; frames.length < BENCH_WARM + BENCH_RUNS; t += 1 / 60) {
    const m = song.step(1 / 60);
    if (t >= start) frames.push(copySig(m.sig));
  }
  return frames;
}

/**
 * Amortized ms per render: warm renders, then a timed run closed by one one-pixel read-back. Without
 * `drop` the frame is the lab's rest frame; with it, each render takes the next recorded frame of the song
 * and the track is playing. `cold` is the first render's own time, shader compile included.
 */
function throughput(
  kind: string,
  theme: LabTheme,
  layout: LabLayoutId,
  cover: ImageBitmap,
  drop: VisualSignal[] | null,
): { ms: number; cold: number } {
  const { canvas, renderer } = open(layout);
  const gl = canvas.getContext("webgl2") as WebGL2RenderingContext;
  const sync = () => gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(4));
  const drawn = sceneTheme(darkOnlyOf(kind), theme);
  applyTheme(drawn);
  const frame = labFrame(drawn, layout, cover);
  const draw = (i: number) =>
    renderer.render(kind, { ...frame, ...(drop ? { sig: drop[i % drop.length] } : {}), t: 1 + i / 60, still: false });
  reseed();
  const first = performance.now();
  draw(0);
  sync();
  const cold = performance.now() - first;
  for (let i = 1; i < BENCH_WARM; i++) draw(i);
  sync();
  const start = performance.now();
  for (let i = 0; i < BENCH_RUNS; i++) draw(BENCH_WARM + i);
  sync();
  const ms = (performance.now() - start) / BENCH_RUNS;
  renderer.dispose();
  return { ms, cold };
}

async function runBench() {
  const cover = await coverPixels();
  const theme: LabTheme = params.get("theme") === "light" ? "light" : "dark";
  const layout: LabLayoutId = params.get("layout") === "player" ? "player" : "ambient";
  const ref = params.get("ref");
  if (ref && !(GL_KINDS as readonly string[]).includes(ref)) throw new Error(`unknown GL kind: ${ref}`);
  const drop = ref ? recordDrop() : null;
  const against = ref ?? "glass";
  // The reference's time keeps its old name when the reference is the default one.
  const refKey = ref ? "refMs" : "glassMs";
  const rows: Record<string, number | string>[] = [];
  for (const dpr of BENCH_DPRS) {
    setDpr(dpr);
    for (const kind of pickKinds(GL_KINDS)) {
      const own = throughput(kind, theme, layout, cover, drop);
      const base = throughput(against, theme, layout, cover, drop);
      rows.push({ kind, dpr, ms: round(own.ms), coldMs: round(own.cold), [refKey]: round(base.ms), ratio: round(own.ms / base.ms) });
    }
  }
  return {
    theme,
    layout,
    ref: against,
    signal: drop ? "the song's drop at Lively, playing" : "the lab rest frame",
    rows,
  };
}

/** Shows one kind on its ground in the page, blended the way the app blends it. */
async function runView() {
  const kind = pickKinds(["glass"])[0];
  const theme = pickThemes()[0];
  const layoutId = pickLayouts()[0];
  const layout = LAB_LAYOUTS[layoutId];
  const drawn = sceneTheme(darkOnlyOf(kind), theme);
  applyTheme(drawn);
  setDpr(1);
  const cover = await coverPixels();
  const frame = labFrame(drawn, layoutId, cover);
  const [r, g, b] = frame.ground;

  const stage = document.createElement("div");
  stage.style.cssText = `position:relative;width:${layout.width}px;height:${layout.height}px;background:rgb(${Math.round(r * 255)},${Math.round(g * 255)},${Math.round(b * 255)});overflow:hidden`;
  const { canvas, renderer } = open(layoutId);
  canvas.style.cssText = `position:absolute;inset:0;width:100%;height:100%;mix-blend-mode:${blendOf(kind, frame.light)}`;
  const tile = paintCover(512);
  const [cx, cy, cw, ch] = layout.cover;
  tile.style.cssText = `position:absolute;left:${cx}px;top:${cy}px;width:${cw}px;height:${ch}px;border-radius:${layout.radius}px`;
  stage.append(canvas, tile);
  document.body.appendChild(stage);

  reseed();
  if (params.get("anim") === "1") {
    // song=1 plays the song from its start at the reactivity in react=; otherwise the frame holds the rest signal.
    const react = params.get("react");
    const song = params.get("song") === "1" ? createLabSong(0, react === "calm" || react === "lively" ? react : "balanced") : null;
    let last = 0;
    const loop = (now: number) => {
      const dt = last ? Math.min(0.05, (now - last) / 1000) : 1 / 60;
      last = now;
      const sig = song ? song.step(dt).sig : frame.sig;
      renderer.render(kind, { ...frame, sig, t: now / 1000, dt, still: false });
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
  } else {
    renderer.still(kind, { ...frame, t: LAB_T });
  }
  return { kind, theme, layout: layoutId };
}

// Flash check: the WCAG 2.3.1 general-flash window, 341 x 256 px, and the relative-luminance step that counts.
const FLASH_WINDOW_W = 341;
const FLASH_WINDOW_H = 256;
const FLASH_STEP = 0.1;
const FLASH_FRAMES = 31;

/**
 * Fireflies' worst case through the real renderer: every light at its blink floor, the level at maximum, once
 * with no swell and once with the group at full swell. Reports the share of the stage that changes by 0.1
 * relative luminance or more, and the most inside any 341 x 256 window.
 */
async function runFireflyFlash() {
  const cover = await coverPixels();
  const theme: LabTheme = params.get("theme") === "light" ? "light" : "dark";
  applyTheme(theme);
  setDpr(1);
  const rows: { layout: string; theme: string; stagePct: number; windowPct: number }[] = [];
  fireflyProbe.floor = true;
  try {
    for (const layout of pickLayouts()) {
      const base = labFrame(theme, layout, cover);
      const shot = (swell: boolean): Uint8Array => {
        const { canvas, renderer } = open(layout);
        reseed();
        for (let i = 0; i < FLASH_FRAMES; i++) {
          const sig = { ...base.sig, level: 1, drive: 1.5, beat: swell && i === 0 ? 1 : 0 };
          renderer.render("fireflies", { ...base, sig, t: 14 + i / 60, still: false });
        }
        const bytes = readPixels(canvas);
        renderer.dispose();
        return bytes;
      };
      const rest = shot(false);
      const full = shot(true);
      const w = LAB_LAYOUTS[layout].width;
      const h = LAB_LAYOUTS[layout].height;
      const mask = new Uint8Array(w * h);
      let changed = 0;
      for (let i = 0; i < w * h; i++) {
        const hit = Math.abs(relativeLuminance(full, i * 4) - relativeLuminance(rest, i * 4)) >= FLASH_STEP ? 1 : 0;
        mask[i] = hit;
        changed += hit;
      }
      const worst = worstWindow(mask, w, h, FLASH_WINDOW_W, FLASH_WINDOW_H);
      rows.push({
        layout,
        theme,
        stagePct: round((100 * changed) / (w * h)),
        windowPct: round((100 * worst) / (FLASH_WINDOW_W * FLASH_WINDOW_H)),
      });
    }
  } finally {
    fireflyProbe.floor = false;
  }
  return rows;
}

// The kinds whose mockups carry a colour split, so the flash measure also checks saturated-red changes.
const RED_CHECKED = ["neon-highway", "hologram"];

/** The scene a measure runs on, with the themes and layouts the query asks for. */
async function probeOf(): Promise<Probe> {
  const kind = pickKinds([])[0];
  if (!kind) throw new Error("this mode needs kind= or scene=");
  setDpr(1);
  return {
    kind,
    darkOnly: darkOnlyOf(kind),
    cover: await coverPixels(),
    themes: pickThemes(),
    layouts: pickLayouts(),
    open,
  };
}

async function main() {
  const mode = params.get("mode") ?? "view";
  document.body.style.margin = "0";
  const sceneId = params.get("scene");
  if (sceneId) scene = await loadScene(sceneId, params.get("dark") === "1");
  const result = await withSeededRandom(async () => {
    switch (mode) {
      case "hash":
        return runHash();
      case "thumb":
        return runThumb();
      case "bench":
        return runBench();
      case "flash": {
        if (!scene && !params.get("kind")) return runFireflyFlash();
        const probe = await probeOf();
        const red = params.get("red");
        return runDropFlash(probe, red ? red === "1" : RED_CHECKED.includes(probe.kind));
      }
      case "steps":
        return runSteps(await probeOf());
      case "level":
        return runLevel(await probeOf(), Number(params.get("level") ?? 0.4));
      case "calm":
        return runCalm(await probeOf());
      case "view":
        return runView();
      default:
        throw new Error(`unknown mode: ${mode}`);
    }
  });
  const out = document.createElement("pre");
  out.id = "out";
  out.hidden = mode === "view";
  out.textContent = JSON.stringify(result);
  document.body.appendChild(out);
}

main()
  .catch((e) => {
    const out = document.createElement("pre");
    out.id = "out";
    out.textContent = JSON.stringify({ error: String(e instanceof Error ? e.message : e) });
    document.body.appendChild(out);
  })
  .finally(() => {
    document.body.dataset.done = "1";
  });
