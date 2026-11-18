/*
 * The lab's bench mode: milliseconds per render for each kind, as a ratio to a reference kind, at pixel
 * ratios 1 and 2. Timing needs a real GPU and a real clock; the numbers are only comparable within a run.
 */

// -- Local Imports --
import { DROP_START, createLabSong } from "./labSong";
import { applyTheme, coverPixels, labFrame, reseed, sceneTheme, setDpr, type LabLayoutId, type LabTheme } from "./labScene";
import { round } from "./labPixels";
import { darkOnlyOf, openLab, type LabScene } from "./labSceneModule";

// -- Type Imports --
import type { VisualSignal } from "../../state/player/visualSignal";

// Warm-up renders absorb the shader compiles, then the timed run is amortized over one sync.
const BENCH_WARM = 10;
const BENCH_RUNS = 60;
const BENCH_DPRS = [1, 2];

/** One recorded song frame: the signal and the fine spectrum a kind that draws from it reads. */
interface DropFrame {
  sig: VisualSignal;
  fine: number[];
}

/** The song's frame by frame at Lively from two seconds into the drop: warm-up frames, then the timed ones. */
function recordDrop(): DropFrame[] {
  const song = createLabSong(0, "lively");
  const start = DROP_START + 2;
  const frames: DropFrame[] = [];
  for (let t = 0; frames.length < BENCH_WARM + BENCH_RUNS; t += 1 / 60) {
    const m = song.step(1 / 60);
    // The follower rewrites its own object and bands array on every step, so a frame is copied whole.
    if (t >= start) frames.push({ sig: { ...m.sig, bands: Float32Array.from(m.sig.bands) }, fine: m.fine });
  }
  return frames;
}

/**
 * Amortized ms per render: warm renders, then a timed run closed by one one-pixel read-back. Without
 * `drop` the frame is the lab's rest frame; with it, each render takes the next recorded frame of the song
 * and the track is playing. `cold` is the first render's own time, shader compile included.
 */
function throughput(
  scene: LabScene | null,
  kind: string,
  theme: LabTheme,
  layout: LabLayoutId,
  cover: ImageBitmap,
  drop: DropFrame[] | null,
  needsFine: (kind: string) => boolean,
): { ms: number; cold: number } {
  const { canvas, renderer } = openLab(scene, layout);
  const gl = canvas.getContext("webgl2") as WebGL2RenderingContext;
  const sync = () => gl.readPixels(0, 0, 1, 1, gl.RGBA, gl.UNSIGNED_BYTE, new Uint8Array(4));
  const drawn = sceneTheme(darkOnlyOf(scene, kind), theme);
  applyTheme(drawn);
  const frame = labFrame(drawn, layout, cover);
  const fine = needsFine(kind);
  const draw = (i: number) => {
    const rec = drop ? drop[i % drop.length] : null;
    renderer.render(kind, { ...frame, ...(rec ? { sig: rec.sig, fine: fine ? rec.fine : null } : {}), t: 1 + i / 60, still: false });
  };
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

/** What a bench run covers: the kinds, one theme, the layouts, and the reference kind (null for Glass at rest). */
export interface BenchRun {
  scene: LabScene | null;
  kinds: string[];
  theme: LabTheme;
  layouts: LabLayoutId[];
  ref: string | null;
  // Whether a kind draws from the fine spectrum.
  needsFine: (kind: string) => boolean;
}

export async function runBench(run: BenchRun) {
  const { scene, kinds, theme, layouts, ref, needsFine } = run;
  const cover = await coverPixels();
  const drop = ref ? recordDrop() : null;
  const against = ref ?? "glass";
  // The reference's time field: glassMs for the default Glass reference, refMs for a chosen kind.
  const refKey = ref ? "refMs" : "glassMs";
  const rows: Record<string, number | string>[] = [];
  for (const dpr of BENCH_DPRS) {
    setDpr(dpr);
    for (const layout of layouts) {
      for (const kind of kinds) {
        const own = throughput(scene, kind, theme, layout, cover, drop, needsFine);
        const base = throughput(scene, against, theme, layout, cover, drop, needsFine);
        rows.push({ kind, layout, dpr, ms: round(own.ms), coldMs: round(own.cold), [refKey]: round(base.ms), ratio: round(own.ms / base.ms) });
      }
    }
  }
  return {
    theme,
    layouts,
    ref: against,
    signal: drop ? "the song's drop at Lively, playing" : "the lab rest frame",
    rows,
  };
}
