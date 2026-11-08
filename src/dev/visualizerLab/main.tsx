/*
 * The visualizer render lab. A dev-only page that draws the GL kinds through the real renderer from a
 * fixed scene. Query params: mode=view|hash|thumb|bench|flash, kind (one GL kind; absent means all of them,
 * except view, which takes glass), theme=light|dark and layout=player|ambient (absent means both for
 * hash). Every non-view mode writes its result as JSON into <pre id="out"> and sets body[data-done].
 */

// -- Local Imports --
import { fireflyProbe } from "../../components/player/visualizers/gl/fireflies";
import { blendModeFor, createRenderer, type Renderer } from "../../components/player/visualizers/gl/renderer";
import {
  LAB_LAYOUTS,
  LAB_T,
  applyTheme,
  coverPixels,
  labFrame,
  paintCover,
  reseed,
  setDpr,
  withSeededRandom,
  type LabLayoutId,
  type LabTheme,
} from "./labScene";

// -- State Imports --
import { VISUALIZER_KINDS, isGlKind, type GlKind } from "../../state/player/visualizerKind";

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

function pickKinds(fallback: readonly GlKind[]): GlKind[] {
  const raw = params.get("kind");
  if (!raw) return [...fallback];
  if (!(GL_KINDS as readonly string[]).includes(raw)) throw new Error(`unknown GL kind: ${raw}`);
  return [raw as GlKind];
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
function open(layoutId: LabLayoutId): { canvas: HTMLCanvasElement; renderer: Renderer } {
  const canvas = document.createElement("canvas");
  const renderer = createRenderer(canvas);
  if (!renderer) throw new Error("WebGL2 unavailable");
  renderer.fit(LAB_LAYOUTS[layoutId]);
  return { canvas, renderer };
}

/** The bytes of the canvas' default framebuffer, read straight after a draw. */
function readPixels(canvas: HTMLCanvasElement): Uint8Array {
  const gl = canvas.getContext("webgl2") as WebGL2RenderingContext;
  const out = new Uint8Array(canvas.width * canvas.height * 4);
  gl.readPixels(0, 0, canvas.width, canvas.height, gl.RGBA, gl.UNSIGNED_BYTE, out);
  return out;
}

async function sha256(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

async function runHash() {
  const cover = await coverPixels();
  const rows: { kind: string; theme: string; layout: string; sha256: string }[] = [];
  setDpr(1);
  for (const kind of pickKinds(GL_KINDS)) {
    for (const theme of pickThemes()) {
      applyTheme(theme);
      for (const layout of pickLayouts()) {
        const { canvas, renderer } = open(layout);
        reseed();
        renderer.still(kind, labFrame(theme, layout, cover));
        rows.push({ kind, theme, layout, sha256: await sha256(readPixels(canvas)) });
        renderer.dispose();
      }
    }
  }
  return rows;
}

/** One kind's ambient still composited onto the theme ground, with the cover tile on top. */
function composeThumb(kind: GlKind, theme: LabTheme, cover: ImageBitmap): string {
  const layout = LAB_LAYOUTS.ambient;
  const { canvas, renderer } = open("ambient");
  reseed();
  const frame = labFrame(theme, "ambient", cover);
  renderer.still(kind, frame);

  const full = document.createElement("canvas");
  full.width = canvas.width;
  full.height = canvas.height;
  const x = full.getContext("2d");
  if (!x) throw new Error("2d context unavailable");
  const [r, g, b] = frame.ground;
  x.fillStyle = `rgb(${Math.round(r * 255)},${Math.round(g * 255)},${Math.round(b * 255)})`;
  x.fillRect(0, 0, full.width, full.height);
  x.globalCompositeOperation = COMPOSITE_OP[blendModeFor(kind, frame.light)];
  x.drawImage(canvas, 0, 0);
  x.globalCompositeOperation = "source-over";
  const [cx, cy, cw, ch] = layout.cover;
  x.save();
  x.beginPath();
  x.roundRect(cx, cy, cw, ch, layout.radius);
  x.clip();
  x.drawImage(paintCover(512), cx, cy, cw, ch);
  x.restore();
  renderer.dispose();

  const thumb = document.createElement("canvas");
  thumb.width = THUMB_W;
  thumb.height = THUMB_H;
  const t = thumb.getContext("2d");
  if (!t) throw new Error("2d context unavailable");
  t.imageSmoothingQuality = "high";
  t.drawImage(full, 0, 0, THUMB_W, THUMB_H);
  return thumb.toDataURL("image/webp", THUMB_QUALITY);
}

async function runThumb() {
  const cover = await coverPixels();
  const rows: { kind: string; theme: string; dataUrl: string }[] = [];
  setDpr(1);
  for (const kind of pickKinds(GL_KINDS)) {
    for (const theme of pickThemes()) {
      applyTheme(theme);
      rows.push({ kind, theme, dataUrl: composeThumb(kind, theme, cover) });
    }
  }
  return rows;
}

/** Amortized ms per render: warm renders, then a timed run closed by one one-pixel read-back. */
function throughput(kind: GlKind, theme: LabTheme, layout: LabLayoutId, cover: ImageBitmap): number {
  const { canvas, renderer } = open(layout);
  const gl = canvas.getContext("webgl2") as WebGL2RenderingContext;
  const sync = () => gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(4));
  const frame = labFrame(theme, layout, cover);
  const draw = (i: number) => renderer.render(kind, { ...frame, t: 1 + i / 60, still: false });
  reseed();
  for (let i = 0; i < BENCH_WARM; i++) draw(i);
  sync();
  const start = performance.now();
  for (let i = 0; i < BENCH_RUNS; i++) draw(i);
  sync();
  const ms = (performance.now() - start) / BENCH_RUNS;
  renderer.dispose();
  return ms;
}

async function runBench() {
  const cover = await coverPixels();
  const theme: LabTheme = params.get("theme") === "light" ? "light" : "dark";
  const layout: LabLayoutId = params.get("layout") === "player" ? "player" : "ambient";
  applyTheme(theme);
  const rows: { kind: string; dpr: number; ms: number; glassMs: number; ratio: number }[] = [];
  for (const dpr of BENCH_DPRS) {
    setDpr(dpr);
    for (const kind of pickKinds(GL_KINDS)) {
      const ms = throughput(kind, theme, layout, cover);
      const glassMs = throughput("glass", theme, layout, cover);
      rows.push({ kind, dpr, ms: round(ms), glassMs: round(glassMs), ratio: round(ms / glassMs) });
    }
  }
  return { theme, layout, rows };
}

function round(v: number): number {
  return Math.round(v * 1000) / 1000;
}

/** Shows one kind on its ground in the page, blended the way the app blends it. */
async function runView() {
  const kind = pickKinds(["glass"])[0];
  const theme = pickThemes()[0];
  const layoutId = pickLayouts()[0];
  const layout = LAB_LAYOUTS[layoutId];
  applyTheme(theme);
  setDpr(1);
  const cover = await coverPixels();
  const frame = labFrame(theme, layoutId, cover);
  const [r, g, b] = frame.ground;

  const stage = document.createElement("div");
  stage.style.cssText = `position:relative;width:${layout.width}px;height:${layout.height}px;background:rgb(${Math.round(r * 255)},${Math.round(g * 255)},${Math.round(b * 255)});overflow:hidden`;
  const { canvas, renderer } = open(layoutId);
  canvas.style.cssText = `position:absolute;inset:0;width:100%;height:100%;mix-blend-mode:${blendModeFor(kind, frame.light)}`;
  const tile = paintCover(512);
  const [cx, cy, cw, ch] = layout.cover;
  tile.style.cssText = `position:absolute;left:${cx}px;top:${cy}px;width:${cw}px;height:${ch}px;border-radius:${layout.radius}px`;
  stage.append(canvas, tile);
  document.body.appendChild(stage);

  reseed();
  if (params.get("anim") === "1") {
    const loop = (now: number) => {
      renderer.render(kind, { ...frame, t: now / 1000, still: false });
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

function linearLuma(bytes: Uint8Array, i: number): number {
  const lin = (v: number) => {
    const c = v / 255;
    return c <= 0.04045 ? c / 12.92 : ((c + 0.055) / 1.055) ** 2.4;
  };
  return 0.2126 * lin(bytes[i]) + 0.7152 * lin(bytes[i + 1]) + 0.0722 * lin(bytes[i + 2]);
}

/**
 * Fireflies' worst case through the real renderer: every light at its blink floor, the level at maximum, once
 * with no swell and once with the group at full swell. Reports the share of the stage that changes by 0.1
 * relative luminance or more, and the most inside any 341 x 256 window.
 */
async function runFlash() {
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
      // Summed-area table over the changed pixels.
      const sat = new Int32Array((w + 1) * (h + 1));
      let changed = 0;
      for (let y = 0; y < h; y++) {
        let row = 0;
        for (let x = 0; x < w; x++) {
          const i = (y * w + x) * 4;
          const hit = Math.abs(linearLuma(full, i) - linearLuma(rest, i)) >= FLASH_STEP ? 1 : 0;
          row += hit;
          changed += hit;
          sat[(y + 1) * (w + 1) + x + 1] = sat[y * (w + 1) + x + 1] + row;
        }
      }
      let worst = 0;
      for (let y = 0; y + FLASH_WINDOW_H <= h; y += 4) {
        for (let x = 0; x + FLASH_WINDOW_W <= w; x += 4) {
          const a = sat[(y + FLASH_WINDOW_H) * (w + 1) + x + FLASH_WINDOW_W] - sat[y * (w + 1) + x + FLASH_WINDOW_W];
          const n = a - sat[(y + FLASH_WINDOW_H) * (w + 1) + x] + sat[y * (w + 1) + x];
          if (n > worst) worst = n;
        }
      }
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

async function main() {
  const mode = params.get("mode") ?? "view";
  document.body.style.margin = "0";
  const result = await withSeededRandom(async () => {
    switch (mode) {
      case "hash":
        return runHash();
      case "thumb":
        return runThumb();
      case "bench":
        return runBench();
      case "flash":
        return runFlash();
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
