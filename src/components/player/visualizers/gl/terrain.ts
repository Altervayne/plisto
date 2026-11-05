/*
 * Terrain: the spectrum history as ridgelines receding in perspective, new lines arriving at the front.
 * Every line hides the ones behind it. Bass lifts the near lines (motion, the beat accent) and the far
 * lines cool into the palette's second color; brightness follows only the eased level.
 *
 * Each line is mirrored about its centre, low frequencies in the middle. The 128-band spectrum draws it
 * when the engine sends one; otherwise the 24 bands are interpolated and given a noise detail so the
 * line keeps its jagged peaks.
 */

// -- Local Imports --
import { restSignal, type VisualSignal } from "../../../../state/player/visualSignal";

// -- Type Imports --
import type { Candidate, Frame, Kit } from "./kit";

const ROWS = 64;
const COLS = 160;
// New lines per second.
const PUSH_HZ = 22;
// The interpolated path's mean gain with its noise detail, so a fine line stands at the same height.
const FINE_GAIN = 0.975;
// The ambient framing: the camera centre and the projection unit as fractions of the stage height.
const AMBIENT_CENTER = 0.62;
const AMBIENT_UNIT = 0.5;
// A row's floor sits this far below the camera centre at depth 1, in projection units.
const FLOOR_DROP = 0.96;
// Where ambient's near line rests, as a fraction of the stage height.
const AMBIENT_FLOOR = AMBIENT_CENTER - FLOOR_DROP * AMBIENT_UNIT;
// Half a line's width at depth 1, in projection units.
const HALF_SPAN = 1.3 * 1.6;
// The screen shape ambient is framed for. Its near line overhangs the stage by this ratio, which the
// Player keeps against the hero column's width.
const AMBIENT_ASPECT = 16 / 9;
const AMBIENT_OVERHANG = (HALF_SPAN * AMBIENT_UNIT) / (AMBIENT_ASPECT / 2);
// The Player's near line clears the seek bar by this many CSS pixels.
const PLAYER_FLOOR_GAP = 14;

const VS = `#version 300 es
precision highp float;
layout(location = 0) in vec2 aV;
uniform sampler2D uHist;
uniform int uRowTex;
uniform float uDepth;
uniform float uAmp;
uniform vec2 uCenter;
uniform vec2 uScale;
uniform float uLineW;
uniform float uSpread;
uniform int uIsLine;
out float vU;
void main() {
  int col = int(aV.x * ${COLS - 1}.0 + 0.5);
  float h = texelFetch(uHist, ivec2(col, uRowTex), 0).r;
  float x = (aV.x - 0.5) * 2.6 * uSpread;
  float y = h * uAmp;
  if (uIsLine == 0 && aV.y < 0.5) y = -0.8;
  float z = uDepth;
  vec2 s = vec2(x * 1.6 / z, (y - 0.6) * 1.6 / z);
  vec2 ndc = uCenter + s * uScale;
  if (uIsLine == 1) ndc.y += aV.y * uLineW;
  vU = aV.x;
  gl_Position = vec4(ndc, 0.0, 1.0);
}`;

const FS = `#version 300 es
precision highp float;
precision highp int;
uniform vec3 uColor;
uniform int uIsLine;
in float vU;
out vec4 outColor;
void main() {
  if (uIsLine == 0) { outColor = vec4(uColor * 0.03, 1.0); return; }
  float edge = smoothstep(0.0, 0.1, vU) * smoothstep(1.0, 0.9, vU);
  outColor = vec4(uColor * edge, 1.0);
}`;

function hash(n: number): number {
  const v = Math.sin(n * 127.1 + 311.7) * 43758.5453;
  return v - Math.floor(v);
}

function noise(x: number): number {
  const i = Math.floor(x);
  const f = x - i;
  const u = f * f * (3 - 2 * f);
  return hash(i) * (1 - u) + hash(i + 1) * u;
}

/** Samples a band list at `m` in 0..1 with linear interpolation. */
function sample(bands: ArrayLike<number>, m: number): number {
  const last = bands.length - 1;
  const f = m * last;
  const i = Math.min(last - 1, Math.floor(f));
  const k = f - i;
  return bands[i] * (1 - k) + bands[i + 1] * k;
}

type Rgb = [number, number, number];

function lerp3(a: Rgb, b: Rgb, k: number): Rgb {
  return [a[0] + (b[0] - a[0]) * k, a[1] + (b[1] - a[1]) * k, a[2] + (b[2] - a[2]) * k];
}

export function createTerrain(kit: Kit): Candidate {
  const { gl } = kit;
  const hist = new Float32Array(ROWS * COLS);
  let head = 0;
  let acc = 0;

  const pushRow = (s: VisualSignal, fine: number[] | null) => {
    head = (head + 1) % ROWS;
    const seed = Math.random() * 1000;
    const row = head * COLS;
    for (let c = 0; c < COLS; c++) {
      const u = c / (COLS - 1);
      const m = Math.abs(2 * u - 1);
      const env = Math.max(0, 1 - m / 0.72) ** 1.6;
      const floor = 0.006 * noise(u * 70 + seed);
      if (fine) {
        hist[row + c] = env * (sample(fine, m) * FINE_GAIN + 0.015) + floor;
      } else {
        const band = sample(s.bands, m);
        const detail = noise(u * 19 + seed) * 0.65 + noise(u * 43 + seed * 1.7) * 0.35;
        hist[row + c] = env * (band * 0.45 + band * detail * 1.05 + 0.015) + floor;
      }
    }
  };

  const tex = gl.createTexture();
  if (!tex) throw new Error("texture allocation failed");
  gl.bindTexture(gl.TEXTURE_2D, tex);
  gl.texImage2D(gl.TEXTURE_2D, 0, gl.R32F, COLS, ROWS, 0, gl.RED, gl.FLOAT, hist);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);

  const buffers: WebGLBuffer[] = [];
  const strip = (lo: number, hi: number) => {
    const d = new Float32Array(COLS * 4);
    for (let c = 0; c < COLS; c++) {
      const u = c / (COLS - 1);
      d.set([u, lo, u, hi], c * 4);
    }
    const vao = gl.createVertexArray();
    const vbo = gl.createBuffer();
    if (vbo) buffers.push(vbo);
    gl.bindVertexArray(vao);
    gl.bindBuffer(gl.ARRAY_BUFFER, vbo);
    gl.bufferData(gl.ARRAY_BUFFER, d, gl.STATIC_DRAW);
    gl.enableVertexAttribArray(0);
    gl.vertexAttribPointer(0, 2, gl.FLOAT, false, 0, 0);
    gl.bindVertexArray(null);
    return vao;
  };
  const fillVao = strip(0, 1);
  const lineVao = strip(-1, 1);
  const rest = restSignal();
  for (let r = 0; r < ROWS; r++) pushRow(rest, null);

  return {
    mode: "glow",
    bloom: 0.55,
    exposure: 1.5,
    inkGain: 1.6,
    trail: null,
    draw(f: Frame) {
      if (!f.still) {
        acc += f.dt * PUSH_HZ;
        while (acc >= 1) {
          acc -= 1;
          pushRow(f.sig, f.fine);
        }
      } else {
        for (let r = 0; r < ROWS; r++) pushRow(f.sig, null);
        acc = 0;
      }
      gl.bindTexture(gl.TEXTURE_2D, tex);
      gl.texSubImage2D(gl.TEXTURE_2D, 0, 0, 0, COLS, ROWS, gl.RED, gl.FLOAT, hist);
      const p = kit.program("terrain", VS, FS);
      gl.useProgram(p.handle);
      kit.bindTex(p, "uHist", 0, tex);
      const { w: W, h: H, dpr } = kit.size;
      const c = kit.geo.cover;
      let cx: number;
      let cy: number;
      let unit: number;
      let spread = 1;
      if (f.ambient) {
        cx = W * 0.5;
        cy = H * AMBIENT_CENTER;
        unit = H * AMBIENT_UNIT;
      } else {
        // Ambient's framing scaled onto the stage above the seek bar: the near line rests just over the
        // bar, the unit keeps ambient's ratio to the height above that floor so the horizon and depth read
        // the same, and the lines narrow to span the hero column as ambient's span the screen.
        const floor = kit.geo.floor != null ? kit.geo.floor + PLAYER_FLOOR_GAP * dpr : H * AMBIENT_FLOOR;
        const halfWidth = (kit.geo.mask ? kit.geo.mask[2] : W) / 2;
        unit = ((H - floor) * AMBIENT_UNIT) / (1 - AMBIENT_FLOOR);
        cx = c[0] + c[2] / 2;
        cy = floor + FLOOR_DROP * unit;
        spread = (halfWidth * AMBIENT_OVERHANG) / (HALF_SPAN * unit);
      }
      kit.set2(p, "uCenter", (cx / W) * 2 - 1, (cy / H) * 2 - 1);
      kit.set2(p, "uScale", (unit * 2) / W, (unit * 2) / H);
      kit.set1(p, "uSpread", spread);
      const pal = f.palette;
      const warm: Rgb = [pal[6], pal[7], pal[8]];
      const coral: Rgb = [pal[0], pal[1], pal[2]];
      const teal: Rgb = [pal[3], pal[4], pal[5]];
      const frac = acc;
      const s = f.sig;
      const lineW = (f.ambient ? 1.6 : 1.3) * dpr;
      const colorLoc = kit.uniform(p, "uColor");
      for (let r = ROWS - 1; r >= 0; r--) {
        const k = (r + frac) / ROWS;
        const depth = 1.0 + (r + frac) * 0.075;
        const near = (1 - k) ** 2;
        const fade = Math.min(1, (r + frac) * 1.2) * (1 - Math.max(0, (k - 0.82) / 0.18));
        // Bass lifts the near lines; the far lines keep their recorded height.
        kit.set1(p, "uAmp", 0.42 * (1 + s.bass * 1.4 * near));
        kit.set1(p, "uDepth", depth);
        kit.seti(p, "uRowTex", (head - r + ROWS) % ROWS);
        const col = k < 0.35 ? lerp3(warm, coral, k / 0.35) : lerp3(coral, teal, Math.min(1, (k - 0.35) / 0.5));
        const glow = (0.6 + 0.4 * near) * (0.85 + 0.3 * s.level) * fade * (1.15 - k * 0.75);
        gl.disable(gl.BLEND);
        kit.seti(p, "uIsLine", 0);
        gl.uniform3f(colorLoc, col[0] * fade, col[1] * fade, col[2] * fade);
        gl.bindVertexArray(fillVao);
        gl.drawArrays(gl.TRIANGLE_STRIP, 0, COLS * 2);
        gl.enable(gl.BLEND);
        gl.blendFunc(gl.ONE, gl.ONE);
        kit.seti(p, "uIsLine", 1);
        kit.set1(p, "uLineW", (lineW * (0.6 + near * 0.8)) / H);
        gl.uniform3f(colorLoc, col[0] * glow, col[1] * glow, col[2] * glow);
        gl.bindVertexArray(lineVao);
        gl.drawArrays(gl.TRIANGLE_STRIP, 0, COLS * 2);
      }
      gl.bindVertexArray(null);
      gl.disable(gl.BLEND);
    },
    dispose() {
      gl.deleteTexture(tex);
      gl.deleteVertexArray(fillVao);
      gl.deleteVertexArray(lineVao);
      for (const b of buffers) gl.deleteBuffer(b);
    },
  };
}
