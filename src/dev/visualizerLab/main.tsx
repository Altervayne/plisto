/*
 * The visualizer render lab. A dev-only page that draws the GL kinds through the real renderer from a
 * fixed scene. Query params: mode=view|hash|port|thumb|bench|flash|steps|level|calm, kind (one GL kind; absent
 * means all of them, except view, which takes glass), scene=<id> (a scene module the registry does not
 * hold, drawn in place of kind; dark=1 marks it dark-only), theme=light|dark and layout=player|ambient|
 * ambient-side (absent means player and ambient for hash, and player and ambient-side for the measures;
 * view takes player). ambient-side is the app's ambient stage: cover left, words right. Every non-view mode
 * writes its result as JSON into <pre id="out"> and sets body[data-done]. Thumb mode also takes
 * kind=ridge: the Canvas 2D ridge, drawn by its real component. Port mode returns hash's rows for the plugin
 * fixtures (plugin-kit/visualizers/fixtures) drawn through the runtime bundle; kind=ridge there is the
 * hand-written raw port, which hash has no row for.
 *
 * Measures read the composited picture (the layout's ground, then the layer in the kind's blend): steps
 * (brightness steps over a window of the song), flash (with kind or scene: WCAG flashes over the same
 * window, red=0|1 to force the red check; with neither: Fireflies' worst case), level (level=0..1, the
 * brightness a motion signal at its cap adds) and calm (the Calm rule, on the raw framebuffer). steps and
 * flash take from=<s> and for=<s>, the song seconds read (default: the drop from 34 s, for 10 s), and
 * react=calm|balanced|lively (default lively). track=<name> plays a dumped real track
 * (.ai/lab-tracks/<name>.json) in place of the song: from and for then read track seconds, and the animated
 * view (anim=1) plays it from its start. fine=1 marks a scene= module as drawing from the 128-band spectrum,
 * which the registry cannot say for it. bench takes ref=<kind> to time the kinds under the song's drop with
 * the track playing, as a ratio to that kind.
 */

// -- Local Imports --
import {
  LAB_LAYOUTS,
  LAB_T,
  applyTheme,
  coverPixels,
  labFrame,
  paintCover,
  reseed,
  sceneTheme,
  setDpr,
  withSeededRandom,
  type LabLayoutId,
  type LabTheme,
} from "./labScene";
import { runBench } from "./labBench";
import { runLevel, runCalm } from "./labHold";
import { DEFAULT_WINDOW, runDropFlash, runFireflyFlash, runSteps, type Probe } from "./labMeasure";
import { parseReadWindow, pickLayoutIds, pickReactivity } from "./labParams";
import { rgbCss } from "./labCompose";
import { SONG_SECONDS, createLabSong } from "./labSong";
import { createLabReplay, loadTrack, type LoadedTrack } from "./labReplay";
import { blendOf, darkOnlyOf, loadScene, openLab, type LabScene } from "./labSceneModule";
import { runThumb } from "./labThumbs";
import { readPixels, sha256 } from "./labPixels";
import { runPort } from "./labPort";

// -- State Imports --
import {
  VISUALIZER_KINDS,
  isGlKind,
  needsFineSpectrum,
  type VisualizerKind,
} from "../../state/player/visualizerKind";

// -- Style Imports --
import "../../styles/tokens.css";
import "../../styles/base.css";

const THEMES: LabTheme[] = ["light", "dark"];
const GL_KINDS = VISUALIZER_KINDS.filter(isGlKind);
// The layouts a run covers when layout= is absent: hash keeps the two it always had; the measures take the
// Player and the app's real ambient stage.
const HASH_LAYOUTS: LabLayoutId[] = ["player", "ambient"];
const MEASURE_LAYOUTS: LabLayoutId[] = ["player", "ambient-side"];
const VIEW_LAYOUT: LabLayoutId[] = ["player"];

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

/** The kinds a port run draws: the GL kinds, or the raw Ridge port when kind=ridge. */
function pickPortKinds(): string[] {
  return params.get("kind") === "ridge" ? ["ridge"] : pickKinds(GL_KINDS);
}

function pickThumbKinds(): string[] {
  if (scene) return [scene.id];
  return params.get("kind") === "ridge" ? ["ridge"] : params.get("kind") ? pickKinds(GL_KINDS) : ["ridge", ...GL_KINDS];
}

function pickThemes(): LabTheme[] {
  const raw = params.get("theme");
  return raw === "light" || raw === "dark" ? [raw] : THEMES;
}

function open(layoutId: LabLayoutId) {
  return openLab(scene, layoutId);
}

async function runHash() {
  const cover = await coverPixels();
  const rows: { kind: string; theme: string; layout: string; sha256: string }[] = [];
  setDpr(1);
  for (const kind of pickKinds(GL_KINDS)) {
    for (const theme of pickThemes()) {
      const drawn = sceneTheme(darkOnlyOf(scene, kind), theme);
      applyTheme(drawn);
      for (const layout of pickLayoutIds(params.get("layout"), HASH_LAYOUTS)) {
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

/** Shows one kind on its ground in the page, blended the way the app blends it. */
async function runView() {
  const kind = pickKinds(["glass"])[0];
  const theme = pickThemes()[0];
  const layoutId = pickLayoutIds(params.get("layout"), VIEW_LAYOUT)[0];
  const layout = LAB_LAYOUTS[layoutId];
  const drawn = sceneTheme(darkOnlyOf(scene, kind), theme);
  applyTheme(drawn);
  setDpr(1);
  const cover = await coverPixels();
  const frame = labFrame(drawn, layoutId, cover);

  const stage = document.createElement("div");
  stage.style.cssText = `position:relative;width:${layout.width}px;height:${layout.height}px;background:${rgbCss(frame.ground)};overflow:hidden`;
  const { canvas, renderer } = open(layoutId);
  canvas.style.cssText = `position:absolute;inset:0;width:100%;height:100%;mix-blend-mode:${blendOf(scene, kind, frame.light)}`;
  const tile = paintCover(512);
  const [cx, cy, cw, ch] = layout.cover;
  tile.style.cssText = `position:absolute;left:${cx}px;top:${cy}px;width:${cw}px;height:${ch}px;border-radius:${layout.radius}px`;
  stage.append(canvas, tile);
  document.body.appendChild(stage);

  reseed();
  if (params.get("anim") === "1") {
    // song=1 plays the song, or track= the real track, from its start at the reactivity in react=; otherwise
    // the frame holds the rest signal.
    const reactivity = pickReactivity(params.get("react"), "balanced");
    const track = await pickTrack();
    const song = track ? createLabReplay(track.dump, reactivity) : params.get("song") === "1" ? createLabSong(0, reactivity) : null;
    let last = 0;
    const loop = (now: number) => {
      const dt = last ? Math.min(0.05, (now - last) / 1000) : 1 / 60;
      last = now;
      const m = song ? song.step(dt) : null;
      const fine = m && needsFineOf(kind) ? m.fine : null;
      renderer.render(kind, { ...frame, sig: m ? m.sig : frame.sig, fine, t: now / 1000, dt, still: false });
      requestAnimationFrame(loop);
    };
    requestAnimationFrame(loop);
  } else {
    renderer.still(kind, { ...frame, t: LAB_T });
  }
  return { kind, theme, layout: layoutId };
}

// The kinds whose mockups carry a colour split, so the flash measure also checks saturated-red changes.
const RED_CHECKED = ["neon-highway", "hologram"];

/** Whether a kind draws from the fine spectrum: the registry says for a kind; fine=1 says for an unregistered scene. */
function needsFineOf(kind: string): boolean {
  return scene && kind === scene.id ? params.get("fine") === "1" : needsFineSpectrum(kind as VisualizerKind);
}

/** The real track track= names, or null when it is absent. */
async function pickTrack(): Promise<LoadedTrack | null> {
  const name = params.get("track");
  return name ? loadTrack(name) : null;
}

// The window a track run reads when from= and for= are absent: its first ten seconds.
const TRACK_WINDOW = { from: 0, length: 10 };

/** The scene a measure runs on, with the themes, layouts and song window the query asks for. */
async function probeOf(kind: string, windowed = true): Promise<Probe> {
  setDpr(1);
  const track = await pickTrack();
  const defaults = track ? TRACK_WINDOW : DEFAULT_WINDOW;
  const end = track ? track.dump.durationSecs : SONG_SECONDS;
  return {
    kind,
    darkOnly: darkOnlyOf(scene, kind),
    needsFine: needsFineOf(kind),
    window: windowed ? parseReadWindow(params.get("from"), params.get("for"), defaults, end) : defaults,
    reactivity: pickReactivity(params.get("react"), "lively"),
    track,
    blend: (light) => blendOf(scene, kind, light),
    cover: await coverPixels(),
    themes: pickThemes(),
    layouts: pickLayoutIds(params.get("layout"), MEASURE_LAYOUTS),
    open,
  };
}

async function measureProbe(): Promise<Probe> {
  const kind = pickKinds([])[0];
  if (!kind) throw new Error("this mode needs kind= or scene=");
  return probeOf(kind);
}

async function runFlash() {
  if (!scene && !params.get("kind")) {
    const theme: LabTheme = params.get("theme") === "light" ? "light" : "dark";
    if (params.has("from") || params.has("for")) throw new Error("from= and for= do not apply to Fireflies' worst case");
    return runFireflyFlash(await probeOf("fireflies", false), theme);
  }
  const probe = await measureProbe();
  const red = params.get("red");
  return runDropFlash(probe, red ? red === "1" : RED_CHECKED.includes(probe.kind));
}

/** The kind a bench is timed against, or null for Glass at rest. */
function pickRef(): string | null {
  const ref = params.get("ref");
  if (ref && !(GL_KINDS as readonly string[]).includes(ref)) throw new Error(`unknown GL kind: ${ref}`);
  return ref;
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
      case "port":
        setDpr(1);
        return runPort({
          kinds: pickPortKinds(),
          themes: pickThemes(),
          layouts: pickLayoutIds(params.get("layout"), HASH_LAYOUTS),
          cover: await coverPixels(),
        });
      case "thumb":
        return runThumb(scene, pickThumbKinds(), pickThemes());
      case "bench":
        return runBench({
          scene,
          kinds: pickKinds(GL_KINDS),
          theme: params.get("theme") === "light" ? "light" : "dark",
          layouts: pickLayoutIds(params.get("layout"), MEASURE_LAYOUTS),
          ref: pickRef(),
          needsFine: needsFineOf,
        });
      case "flash":
        return runFlash();
      case "steps":
        return runSteps(await measureProbe());
      case "level":
        return runLevel(await measureProbe(), Number(params.get("level") ?? 0.4));
      case "calm":
        return runCalm(await measureProbe());
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
