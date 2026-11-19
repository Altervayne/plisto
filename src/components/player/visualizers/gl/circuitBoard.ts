/*
 * Circuit Board: a close, top-down view of a printed circuit board. The cover is printed on the lid of the big
 * QFP chip in the middle; 64 leads break out into four buses of copper traces with 45 degree jogs and vias that run
 * out across the stage, each side's lanes fitted to the room on that side (circuitFit), and a field of resistors,
 * capacitors, electrolytics, small ICs, crystals, LEDs and headers sits between and beyond them under silkscreen.
 * In the pockets between the buses sit a two-colour OLED, a backlit character LCD on a ribbon, a seven-segment
 * counter with a bar graph and status LEDs, and an I/O header with its activity LEDs; a lane running on under a
 * module ends short of it. Everything is drawn in design pixels (circuitUnit), so the board scales with the cover;
 * the modules scale less and step down where their pocket is tight. By day it is the same board under bench light.
 *
 * The board answers the beat. Each beat sends one burst out of the chip along a share of the lanes, sized and lit
 * by its weight before the gain: a typical loud kick takes half to two thirds of the lanes, only the strongest take
 * every lane and carry on as a front through the loose routing, a kickless onset takes a few, a quiet beat none.
 * Lanes the weight adds as the kick's bass lands start at the leads. Between beats only a slow trickle runs, on a
 * share of the lanes that grows with the loudness and is gone near silence. A surge sends one burst on every lane
 * above any beat's light, with a wave over the whole board; a cut dims the board and stills the trickle for a
 * moment. The field's LEDs and vias blink on the band hits. Bands judged against their own 14 s mean drive the
 * screens and the LOW bar graph; the whole mix fills the channel row.
 *
 * Photosensitivity: the large-area light is uGlow (the eased loudness), the bursts and a full burst's front, the
 * surge's all-lane burst and its wave, and the cut's dim of the whole board around the chip. The bursts and the
 * surge share one launch budget of three a second; each travels outward from the chip and fades over BURST_LIFE,
 * never lighting the board at once. The cut dims over CUT_IN and recovers over CUT_OUT, or with the surge's burst
 * when one lands; by day it dims half as far. The hits light only single LEDs and via holes. Every indicator LED
 * eases over 0.35 s or more and at most one changes state per quarter second; CH0 stays lit once it has come on
 * (hysteresis). The screens keep their lit area: content scrolls or reshapes, a panel never switches on or off.
 * Calm and a paused track start nothing from a motion signal; their trickle idles at IDLE_LANES and an idle burst
 * runs on a timer, one every IDLE_EVERY seconds.
 */

// -- Local Imports --
import { clamp01 } from "./cozy";
import { CYBER_KIT, cyberBands, cyberGain } from "./cyber";
import { createCoverTexture } from "./coverTexture";
import { SCENE_PRELUDE, setScene } from "./scene";
import { FS_VS } from "./shaders";
import { easeEnvelope } from "../../../../state/player/visualSignal";

// -- Type Imports --
import type { Candidate, Frame, Geometry, Kit, ProgramSource } from "./kit";
import type { VisualSignal } from "../../../../state/player/visualSignal";

/** How the board reads the music. */
export const CIRCUIT = {
  // Quick and slow measures of each band; the slow one is the song's recent mean.
  FAST_TAU: 0.6,
  SLOW_TAU: 14,
  // Activity = ABS x the quick measure + REL x its gap over the mean / REL_SPAN, clamped 0..1.
  ABS: 0.7,
  REL: 0.7,
  REL_SPAN: 0.45,
  // Largest change per second of the values the LEDs follow: a field LED's crossing takes 0.4 s, a bar segment 0.33 s.
  SLEW_FIELD: 0.3,
  SLEW_BAR: 0.45,
  SLEW_LANES: 0.2,
  // Indicator LEDs: ease on and off, one flip per FLIP_GAP at most, each held at least FLIP_HOLD.
  LED_UP: 0.35,
  LED_DOWN: 0.6,
  FLIP_GAP: 0.25,
  FLIP_HOLD: 1.2,
  // Screens: trace samples per second, register refresh, the register scroll's shortest gap, the counter's fade.
  TRACE_HZ: 12,
  REG_EVERY: 0.4,
  SCROLL_GAP: 0.45,
  SEG_FADE: 0.4,
  // The trickle between beats: the largest share of lanes it runs on, reached as the loudness climbs from
  // TRICKLE_FROM to TRICKLE_FULL; the share a board with no motion gain idles at.
  TRICKLE: 0.2,
  TRICKLE_FROM: 0.08,
  TRICKLE_FULL: 0.6,
  IDLE_LANES: 0.4,
  // A burst lives BURST_LIFE s and fades in over BURST_RISE; its weight keeps rising for WEIGHT_WINDOW s after the
  // beat as the kick's bass lands. Burst light tops out at BURST_LIGHT, a surge's at SURGE_LIGHT.
  BURST_LIFE: 0.7,
  BURST_RISE: 0.03,
  WEIGHT_WINDOW: 0.15,
  BURST_LIGHT: 1.4,
  SURGE_LIGHT: 1.9,
  SURGE_LIFE: 1.3,
  // The small parts' hit envelopes fall over HIT_TAU.
  HIT_TAU: 0.15,
  // A cut dims the board over CUT_IN, holds CUT_HOLD, recovers over CUT_OUT, or over CUT_LIFT when a surge lands.
  CUT_IN: 0.3,
  CUT_HOLD: 0.6,
  CUT_OUT: 0.9,
  CUT_LIFT: 0.12,
} as const;

// The bus geometry the shader draws and the layout keeps clear, in cover widths unless named: the chip's half
// size; lanes per half side (a bus holds half of them); the lead length and the lane's end pad in design px; the
// straight run before the jog (plus a hash of JOG_HASH); the run after the jog (plus a hash of LANE_SPAN).
const CHIP_H = 0.6;
const LANES = 8;
const LEAD_L = 13;
const LANE_PAD = 7;
const BUS_A = 0.05;
const JOG_HASH = 0.1;
const LANE_MIN = 0.12;
const LANE_SPAN = 0.4;
// The shortest a side's lanes are fitted to, as a share of their full length.
const MIN_FIT = 0.05;
// A burst's share of lanes from its beat's weight before the gain: SHARE_TOP of the lanes just under SHARE_FULL,
// every lane from there.
const SHARE_TOP = 0.72;
const SHARE_FULL = 0.97;

// Burst slots; seconds between the idle bursts of a board with no motion gain; the modules the board places.
const BURST_SLOTS = 4;
const IDLE_EVERY = 5;
const MODULES = 4;
// One design pixel of the board is 1/DESIGN_CW cover width, and never under 1/DESIGN_STAGE of the stage's short
// side, so a small cover on a large stage does not shrink the board into a mosaic. Parts, modules and leads are
// drawn in design pixels.
const DESIGN_CW = 240;
const DESIGN_STAGE = 560;

/** One design pixel in css px for a cover `cw` wide on a `w` x `h` stage. */
export function circuitUnit(cw: number, w: number, h: number): number {
  return Math.max(cw / DESIGN_CW, Math.min(w, h) / DESIGN_STAGE);
}

// 3x5 glyphs for the screens and the silkscreen: '#' is a lit dot, rows top to bottom.
const CIRCUIT_GLYPHS = "0123456789ABCDEFGHIKLMNOPRSTUVWXY:.- ";
const CIRCUIT_FONT = [
  "### #.# #.# #.# ###", ".#. ##. .#. .#. ###", "### ..# ### #.. ###", "### ..# .## ..# ###", "#.# #.# ### ..# ..#",
  "### #.. ### ..# ###", "### #.. ### #.# ###", "### ..# ..# .#. .#.", "### #.# ### #.# ###", "### #.# ### ..# ###",
  ".#. #.# ### #.# #.#", "##. #.# ##. #.# ##.", ".## #.. #.. #.. .##", "##. #.# #.# #.# ##.", "### #.. ##. #.. ###",
  "### #.. ##. #.. #..", ".## #.. #.# #.# .##", "#.# #.# ### #.# #.#", "### .#. .#. .#. ###", "#.# #.# ##. #.# #.#",
  "#.. #.. #.. #.. ###", "#.# ### ### #.# #.#", "##. #.# #.# #.# #.#", ".#. #.# #.# #.# .#.", "##. #.# ##. #.. #..",
  "##. #.# ##. #.# #.#", ".## #.. .#. ..# ##.", "### .#. .#. .#. .#.", "#.# #.# #.# #.# ###", "#.# #.# #.# #.# .#.",
  "#.# #.# ### ### #.#", "#.# #.# .#. #.# #.#", "#.# #.# .#. .#. .#.", "... .#. ... .#. ...", "... ... ... ... .#.",
  "... ... ### ... ...", "... ... ... ... ...",
].map((g) => g.replace(/ /g, "").split("").reduce((bits, ch, i) => bits | (ch === "#" ? 1 << i : 0), 0));

// A silkscreen label of up to four glyphs, packed six bits each into one float (63 ends it).
const circuitLabel = (s: string): string =>
  [0, 1, 2, 3]
    .reduce((v, i) => {
      const g = i < s.length ? CIRCUIT_GLYPHS.indexOf(s[i]) : 63;
      if (g < 0) throw new Error(`no glyph for ${s[i]}`);
      return v + g * 64 ** i;
    }, 0)
    .toFixed(1);

// The board, its parts, the screens and the chip, in one opaque pass.
const FS = `${SCENE_PRELUDE}${CYBER_KIT}
uniform float uPk;
uniform float uGlow;
uniform float uSlow;
uniform vec4 uMod[4];     // module centres, css px, y up: x, y, shown, scale. DSP OLED, REG LCD, SYS, IO
uniform vec4 uBars[4];    // 16 OLED spectrum bars, 0..1
uniform vec4 uTrace[12];  // 48 samples of the OLED's level trace, oldest first
uniform vec4 uInd[4];     // eased indicator states: PWR, SYNC, CLIP, ACT, TX, RX, CH0..CH7
uniform vec3 uSeg;        // seven-segment counter: previous value, value, fade 0..1
uniform float uLow;       // LOW bar graph value (bass against its mean)
uniform float uField;     // field LED activity (highs against their mean)
uniform float uLanes;     // share of bus lanes carrying the trickle
uniform vec4 uFit;        // each side's lane length factor: right, left, top, bottom
// Beat bursts: age s, light, lane seed, age of the second share step; the shares at their three steps and the
// age of the third. A lane joins at the step whose share first covers it.
uniform vec4 uBurst[${BURST_SLOTS}];
uniform vec4 uBurstZ[${BURST_SLOTS}];
uniform vec2 uSurge;      // the surge wave: age s, light
uniform vec3 uHit;        // the small parts' hit envelopes: bass, mids, highs
uniform float uDark;      // a cut's dimming, 0..1
uniform float uLaunch;    // the leads' glow as a burst leaves the chip
uniform vec4 uRegs;       // live register bytes 0..255: bass, mids, highs, level
uniform float uTick;      // register dump clock
uniform float uScroll;    // register rows scrolled by the beats
uniform float uClock;     // uptime, seconds
uniform float uBeatN;     // beat within the bar, 0..3
// -- Tunables --
const float CHIP_H = ${CHIP_H.toFixed(2)};
const float LEAD_L = ${LEAD_L.toFixed(1)};
const float LANES = ${LANES.toFixed(1)};
const float BUS_A = ${BUS_A.toFixed(2)};
const float JOG_HASH = ${JOG_HASH.toFixed(2)};
const float LANE_MIN = ${LANE_MIN.toFixed(2)};
const float LANE_SPAN = ${LANE_SPAN.toFixed(2)};
const float BUS_REACH = 1.0;   // how far past the chip edge the bus is drawn, cover widths: past the longest lane
const float COMP_FROM = 0.14;  // components start this far from the chip edge, cover widths
const float CELL = 46.0;       // component cell, design px
const float BURST_SPEED = 2.4; // cover widths a second
const float BURST_TAIL = 0.10; // cover widths
const float SURGE_SPEED = 1.5; // cover widths a second
const float CUT_DIM = 0.6;
const float SCR_PX = 2.0;      // one OLED or LCD dot, design px
const vec2 MOD_HALF[4] = vec2[4](vec2(54.0, 33.0), vec2(54.0, 39.0), vec2(56.0, 30.0), vec2(56.0, 26.0));
const vec3 C_LANE = vec3(0.10, 1.00, 1.00);
const vec3 C_GRN = vec3(0.20, 1.00, 0.36);
const vec3 C_AMB = vec3(1.00, 0.58, 0.06);
const vec3 C_RED = vec3(1.00, 0.10, 0.06);
const vec3 C_BLU = vec3(0.18, 0.55, 1.00);
const int FONT[${CIRCUIT_FONT.length}] = int[${CIRCUIT_FONT.length}](${CIRCUIT_FONT.join(', ')});
const int SEG7[10] = int[10](63, 6, 91, 79, 102, 109, 125, 7, 127, 111);
// Light the scene gives off this frame: emitted (dies, screen dots, segments) and a halo on the mask (rgb, weight).
vec3 gEmit;
vec4 gHalo;
float gK;
bool gDk;
// The chip centre and half size, and one design px, in css px.
vec2 gCC;
float gH;
float gU;

// Plastic, metal and mask shading from a signed distance: lit from the top left.
vec3 shade(vec3 base, vec2 l, float sd, float k) { return base * (0.82 + 0.22 * clamp(-(l.x * 0.5 - l.y * 0.8) / 14.0, -1.0, 1.0) * k) * (1.0 - 0.25 * smoothstep(-2.5, 0.0, sd)); }
// Dot (col, row) of glyph g, col 0..2 from the left, row 0..4 from the top.
float glyphBit(int g, int c, int r) {
  if (g < 0 || g >= ${CIRCUIT_FONT.length} || c < 0 || c > 2 || r < 0 || r > 4) return 0.0;
  return float((FONT[g] >> (r * 3 + c)) & 1);
}
// A packed label in 1 px silkscreen dots, lp from its bottom left, 4 px advance.
float label(vec2 lp, float packed) {
  if (lp.x < 0.0 || lp.y < 0.0 || lp.y >= 5.0 || lp.x >= 16.0) return 0.0;
  float ch = floor(lp.x / 4.0);
  int g = int(mod(floor(packed / exp2(6.0 * ch)), 64.0));
  ivec2 i = ivec2(floor(lp - vec2(ch * 4.0, 0.0)));
  return glyphBit(g == 63 ? -1 : g, i.x, 4 - i.y);
}
float ind(int i) { return uInd[i >> 2][i & 3]; }
float bar16(int i) { return uBars[i >> 2][i & 3]; }
float trace48(int i) { return uTrace[i >> 2][i & 3]; }
// A part's drop shadow on the board, from its signed distance.
float shadowOf(float sd) { return 1.0 - 0.38 * exp(-max(sd, 0.0) / 3.0) * step(0.0, sd); }

// An 0603 indicator LED along x: tin pads, a milky lens that takes the die colour when lit, the die, a halo on the mask.
void led(inout vec3 col, vec2 l, vec3 lc, float on) {
  float pad = soft(sdBox(vec2(abs(l.x) - 3.3, l.y), vec2(1.3, 1.9)), 0.5);
  float sb = sdRound(l, vec2(2.7, 1.7), 0.8);
  float body = soft(sb, 0.5);
  vec3 tin = gDk ? vec3(0.42, 0.43, 0.44) : vec3(0.74, 0.75, 0.76);
  vec3 lens = mix(gDk ? vec3(0.50, 0.52, 0.50) : vec3(0.88, 0.89, 0.85), gDk ? mix(lc, vec3(1.0), 0.3) : lc * 0.92, on * 0.85);
  col = mix(col, tin, pad);
  col = mix(col, lens * (1.0 - 0.18 * smoothstep(-2.0, 2.0, -l.y)), body);
  float r2 = dot(l, l);
  gEmit += lc * on * gK * (exp(-r2 / 2.0) * 0.8 + body * 0.25);
  gHalo += vec4(lc, 1.0) * on * gK * exp(-r2 / 34.0) * 0.5 * (1.0 - body);
}

// A field status LED at l (0603 along x) with its silk outline: lights when the highs run above their mean, each at
// its own threshold. The threshold band is 0.12 wide and uField moves at most 0.3 a second, so a crossing eases
// over 0.4 s. Each LED also belongs to one band group and blinks on its hits. Returns colour + coverage; the
// light goes to gEmit and gHalo.
vec4 ledPart(vec2 l, vec2 cell, vec3 lc, out float sil) {
  float th = 0.1 + 0.8 * hash21(cell + 31.0);
  float on = max(smoothstep(th - 0.06, th + 0.06, uField), uHit[int(hash21(cell + 12.7) * 2.999)]);
  float pad = soft(sdBox(vec2(abs(l.x) - 3.3, l.y), vec2(1.3, 1.9)), 0.6);
  float body = soft(sdRound(l, vec2(2.7, 1.7), 0.8), 0.6);
  sil = soft(abs(sdBox(l, vec2(6.5, 3.8))) - 0.45, 0.45) * (1.0 - pad) * (1.0 - body);
  vec3 lens = mix(vec3(0.86, 0.87, 0.83), gDk ? mix(lc, vec3(1.0), 0.3) : lc * 0.92, on * 0.85);
  float r2 = dot(l, l);
  gEmit += lc * on * gK * (exp(-r2 / 2.0) * 0.8 + body * 0.25);
  gHalo += vec4(lc, 1.0) * on * gK * exp(-r2 / 34.0) * 0.5 * (1.0 - body);
  return vec4(mix(vec3(0.74, 0.75, 0.76), lens * (1.0 - 0.18 * smoothstep(-2.0, 2.0, -l.y)), body), max(pad, body));
}

// One component in a cell. l is the local position (px, centre origin), h the cell hash. Returns colour + coverage,
// sil gets the silkscreen coverage.
vec4 part(vec2 l, vec2 cell, out float sil) {
  sil = 0.0;
  float h = hash21(cell + 4.1), h2 = hash21(cell + 9.7), h3 = hash21(cell + 17.3);
  if (h2 > 0.5) l = l.yx;
  if (h3 > 0.5) l.x = -l.x;
  vec3 metal = vec3(0.72, 0.74, 0.76);
  vec3 gold = vec3(0.90, 0.70, 0.30);
  float s = 0.7;
  if (h < 0.17) {
    // Resistor: dark body, silver end caps, tin pads, a silk outline.
    float pad = soft(sdBox(vec2(abs(l.x) - 9.5, l.y), vec2(4.0, 5.5)), s);
    float body = soft(sdBox(l, vec2(7.5, 4.0)) - 0.6, s);
    float cap = soft(sdBox(vec2(abs(l.x) - 7.2, l.y), vec2(1.8, 4.0)), s);
    sil = soft(abs(sdBox(l, vec2(15.0, 7.5))) - 0.6, 0.5) * (1.0 - pad);
    vec3 c = mix(gold * 0.85, shade(vec3(0.03, 0.03, 0.035), l, sdBox(l, vec2(7.5, 4.0)), 1.0), body);
    c = mix(c, metal * 0.85, cap * body);
    c += vec3(0.5) * 0.18 * body * smoothstep(0.5, 1.5, abs(l.y)) * step(l.y, -1.0);
    return vec4(c, max(pad, body));
  }
  if (h < 0.33) {
    // Ceramic capacitor: a tan body between two metal caps.
    float pad = soft(sdBox(vec2(abs(l.x) - 8.5, l.y), vec2(3.5, 5.0)), s);
    float body = soft(sdBox(l, vec2(6.5, 3.8)) - 0.6, s);
    float cap = soft(sdBox(vec2(abs(l.x) - 6.2, l.y), vec2(1.6, 3.8)), s);
    sil = soft(abs(sdBox(l, vec2(13.0, 7.0))) - 0.6, 0.5) * (1.0 - pad);
    vec3 c = mix(gold * 0.85, shade(vec3(0.52, 0.36, 0.20), l, sdBox(l, vec2(6.5, 3.8)), 1.0), body);
    c = mix(c, metal * 0.9, cap * body);
    return vec4(c, max(pad, body));
  }
  if (h < 0.43) {
    // Electrolytic can: aluminium top with a cross vent, a dark polarity half and a seat ring.
    float r = length(l);
    float can = soft(r - 15.0, s);
    float top = soft(r - 13.0, s);
    vec3 c = mix(vec3(0.05, 0.05, 0.06), shade(vec3(0.62, 0.64, 0.67), l, r - 13.0, 1.0), can);
    c = mix(c, shade(vec3(0.68, 0.70, 0.72), l, r - 13.0, 1.0), top * can);
    float vent = max(soft(sdBox(l, vec2(7.5, 0.5)), 0.5), soft(sdBox(l, vec2(0.5, 7.5)), 0.5)) * top;
    c = mix(c, vec3(0.30, 0.31, 0.33), vent);
    float pol = soft(r - 15.0, s) * step(8.0, l.x);
    c = mix(c, vec3(0.05, 0.05, 0.06), pol * 0.9);
    sil = soft(abs(r - 19.0) - 0.6, 0.5) * step(0.0, -l.x + 14.0);
    return vec4(c, can);
  }
  if (h < 0.53) {
    // Small IC (SOIC-8): black body, a pin 1 dot, four metal legs a side.
    vec2 b = vec2(11.0, 8.0);
    float body = soft(sdBox(l, b) - 1.0, s);
    float leg = soft(sdBox(vec2(l.x - clamp(l.x, -9.0, 9.0), abs(l.y) - 10.5), vec2(0.5, 2.2)), s) * step(abs(mod(l.x + 11.0, 6.0) - 3.0), 1.2) * step(abs(l.x), 10.0);
    vec3 c = mix(metal * 0.9, shade(vec3(0.03, 0.03, 0.04), l, sdBox(l, b), 1.0), body);
    c += vec3(0.9) * 0.55 * soft(length(l - vec2(-7.5, 5.0)) - 1.1, 0.5) * body;
    c += vec3(0.8) * 0.12 * step(abs(l.y + 1.0), 0.4) * body * step(abs(l.x), 6.0);
    sil = soft(abs(sdBox(l, b + vec2(4.0, 6.5))) - 0.6, 0.5) * (1.0 - body) * (1.0 - leg);
    // Its activity LED, in the corner beside it.
    float s2;
    vec4 e = ledPart((l - vec2(11.0, -19.0)), cell + 0.5, h2 > 0.5 ? C_GRN : C_AMB, s2);
    sil = max(sil * (1.0 - e.a), s2);
    return vec4(mix(c, e.rgb, e.a), max(max(body, leg), e.a));
  }
  if (h < 0.60) {
    // Crystal: a rounded metal can with a dark seam and two pads.
    float body = soft(sdRound(l, vec2(9.5, 6.0), 3.0), s);
    vec3 c = shade(vec3(0.70, 0.72, 0.75), l, sdRound(l, vec2(9.5, 6.0), 3.0), 1.0);
    c = mix(c, vec3(0.18, 0.19, 0.22), soft(abs(abs(l.x) - 6.0) - 0.4, 0.4) * 0.6);
    float pad = soft(sdBox(vec2(abs(l.x) - 9.0, l.y), vec2(2.5, 4.5)), s);
    sil = soft(abs(sdBox(l, vec2(14.0, 8.5))) - 0.6, 0.5) * (1.0 - pad);
    return vec4(mix(gold * 0.8, c, body), max(body, pad));
  }
  if (h < 0.68) {
    // A status LED on its own, its colour from the cover palette or a plain green or amber.
    vec3 lc = h3 < 0.25 ? C_AMB : h3 < 0.5 ? C_GRN : neon(int(hash21(cell + 5.5) * 2.99));
    return ledPart(l, cell, lc, sil);
  }
  if (h < 0.76) {
    // Three vias in a row: tin ring, dark hole. The holes glow on the bass hits.
    vec3 c = vec3(0.0);
    float m = 0.0;
    for (int k = -1; k <= 1; k++) {
      vec2 d = l - vec2(float(k) * 11.0, 0.0);
      float ring = soft(length(d) - 4.4, s);
      m = max(m, ring);
      c = mix(c, mix(gold * 0.9, vec3(0.02, 0.025, 0.03), soft(length(d) - 1.8, 0.5)), ring);
      float r2 = dot(d, d);
      gEmit += C_LANE * uHit.x * gK * exp(-r2 / 5.0);
      gHalo += vec4(C_LANE, 1.0) * uHit.x * gK * exp(-r2 / 40.0) * 0.4 * (1.0 - ring);
    }
    return vec4(c, m);
  }
  if (h < 0.84) {
    // Inductor: a dark rounded block with a lighter top and a marker.
    float body = soft(sdRound(l, vec2(11.0, 11.0), 3.5), s);
    vec3 c = shade(vec3(0.07, 0.07, 0.085), l, sdRound(l, vec2(11.0, 11.0), 3.5), 1.0);
    c += 0.05 * smoothstep(0.0, 10.0, -l.y);
    c = mix(c, vec3(0.45, 0.45, 0.48), soft(abs(sdBox(l, vec2(7.0, 7.0))) - 0.5, 0.5) * 0.5);
    float pad = soft(sdBox(vec2(abs(l.x) - 12.5, l.y), vec2(3.0, 7.0)), s);
    sil = soft(abs(sdBox(l, vec2(17.0, 13.5))) - 0.6, 0.5) * (1.0 - pad) * (1.0 - body);
    // A power-stage inductor carries a green LED below it.
    float s2;
    vec4 e = ledPart(l - vec2(0.0, -19.0), cell + 0.5, C_GRN, s2);
    sil = max(sil * (1.0 - e.a), s2);
    return vec4(mix(mix(gold * 0.85, c, body), e.rgb, e.a), max(max(body, pad), e.a));
  }
  if (h < 0.91) {
    // Header: four gold pins in a row inside a silk frame.
    float m = 0.0;
    vec3 c = vec3(0.0);
    for (int k = 0; k < 4; k++) {
      vec2 d = l - vec2((float(k) - 1.5) * 9.0, 0.0);
      float pin = soft(length(d) - 3.6, s);
      m = max(m, pin);
      c = mix(c, mix(gold, vec3(0.03, 0.03, 0.04), soft(length(d) - 1.3, 0.5)), pin);
    }
    sil = soft(abs(sdBox(l, vec2(19.0, 6.5))) - 0.6, 0.5) * (1.0 - m);
    return vec4(c, m);
  }
  return vec4(0.0);
}

// Dot structure of a screen: at pixel ratio 2 and up the gaps between dots show, below that the dots merge.
float dots(vec2 sp, float vis) {
  vec2 f = abs(fract(sp) - 0.5);
  return 1.0 - vis * 0.38 * step(0.3, max(f.x, f.y));
}

// The DSP module: a blue 0.96 inch OLED board with a two-colour panel (a yellow band over cyan) and a four-pin
// header. Yellow: the level trace scrolling left. Cyan: sixteen spectrum bars.
void dspModule(inout vec3 col, inout float sil, vec2 l, float vis) {
  float sb = sdRound(l, MOD_HALF[0], 3.0);
  col *= shadowOf(sb - 1.0);
  vec3 pcb = gDk ? vec3(0.020, 0.050, 0.150) : vec3(0.070, 0.230, 0.620);
  col = mix(col, shade(pcb, l, sb, 0.6), soft(sb, 0.6));
  vec2 hp = abs(l) - vec2(49.0, 28.0);
  float hr = length(hp);
  vec3 tin = gDk ? vec3(0.50, 0.42, 0.22) : vec3(0.90, 0.76, 0.40);
  col = mix(col, mix(tin, vec3(0.01), soft(hr - 1.3, 0.5)), soft(hr - 2.6, 0.5));
  // The header: a black strip with four gold posts, and its silk.
  vec2 hl = l - vec2(0.0, 27.0);
  col = mix(col, vec3(0.025), soft(sdBox(hl, vec2(16.0, 2.6)), 0.5));
  float post = soft(sdBox(vec2(mod(hl.x + 16.0, 8.0) - 4.0, hl.y), vec2(1.2)), 0.4) * step(abs(hl.x), 16.0);
  col = mix(col, tin * 1.1, post);
  sil = max(sil, label(l - vec2(-44.0, 25.0), ${circuitLabel('OLED')}));
  // The glass and the panel.
  float sg = sdBox(l - vec2(0.0, -6.0), vec2(50.0, 22.0));
  vec3 glass = vec3(0.010, 0.012, 0.016) + 0.025 * smoothstep(20.0, -20.0, l.x + l.y);
  col = mix(col, glass, soft(sg, 0.5));
  vec2 sp = (l - vec2(-48.0, -26.0)) / SCR_PX;
  if (sp.x >= 0.0 && sp.x < 48.0 && sp.y >= 0.0 && sp.y < 20.0) {
    ivec2 ip = ivec2(floor(sp));
    int row = 19 - ip.y;
    float lit = 0.0;
    vec3 oc = vec3(1.0, 0.84, 0.22);
    if (row <= 10) {
      int a = 10 - int(floor(trace48(ip.x) * 10.0 + 0.5));
      int b = ip.x > 0 ? 10 - int(floor(trace48(ip.x - 1) * 10.0 + 0.5)) : a;
      lit = float(row >= min(a, b) && row <= max(a, b));
      lit = max(lit, 0.35 * float(row == 10 && (ip.x & 3) == 0));
    } else if (row >= 12) {
      oc = vec3(0.32, 0.82, 1.0);
      int bi = ip.x / 3;
      int hgt = clamp(int(floor(bar16(bi) * 8.0 + 0.5)), 1, 8);
      lit = float((ip.x - bi * 3) != 2 && 19 - row < hgt);
    }
    col = max(col, oc * lit * dots(sp, vis) * (0.55 + 0.45 * gK));
  }
}

// One LCD character cell of the register dump. Rows 0..2: a register and four bytes; row 3: uptime and the beat.
int lcdChar(int tr, int c) {
  if (tr == 3) {
    float m = mod(floor(uClock / 60.0), 100.0), s = mod(floor(uClock), 60.0);
    if (c == 0) return 28;
    if (c == 1) return 24;
    if (c == 3) return int(floor(m / 10.0));
    if (c == 4) return int(mod(m, 10.0));
    if (c == 5) return 33;
    if (c == 6) return int(floor(s / 10.0));
    if (c == 7) return int(mod(s, 10.0));
    if (c == 9) return 11;
    if (c == 10) return 35;
    if (c == 11) return int(uBeatN) + 1;
    return 36;
  }
  if (c == 2 || c == 7) return 36;
  if (c == 0) return 25;
  float addr = tr == 0 ? 0.0 : mod(uScroll + float(tr) - 1.0, 15.0) + 1.0;
  if (c == 1) return int(addr);
  int k = c < 7 ? c - 3 : c - 4;
  int j = k / 2;
  float v = tr == 0 ? uRegs[j] : floor(hash21(vec2(addr * 7.0 + float(j), floor(uTick * 0.25 + hash21(vec2(addr, float(j))) * 4.0))) * 256.0);
  return (k & 1) == 0 ? int(floor(v / 16.0)) : int(mod(v, 16.0));
}

// The REG module: a backlit yellow-green character LCD in a metal frame, its ribbon running down to a connector.
void regModule(inout vec3 col, inout float sil, vec2 l, float vis) {
  // Connector and ribbon first, under the frame.
  vec2 cl = l - vec2(0.0, -34.0);
  float sz = sdBox(cl, vec2(26.0, 3.5));
  col *= shadowOf(sz - 1.0);
  col = mix(col, shade(vec3(0.05, 0.05, 0.055), cl, sz, 0.6), soft(sz, 0.5));
  col = mix(col, vec3(0.55, 0.50, 0.40), soft(sdBox(cl - vec2(0.0, 1.5), vec2(21.0, 0.7)), 0.4));
  float sr = sdBox(l - vec2(0.0, -26.0), vec2(19.0, 6.0));
  vec3 kapton = (gDk ? vec3(0.42, 0.24, 0.05) : vec3(0.80, 0.50, 0.12)) * (0.9 + 0.1 * smoothstep(-6.0, 6.0, l.y + 26.0));
  kapton = mix(kapton, kapton * 1.35, step(abs(mod(l.x, 3.0) - 1.5), 0.45));
  col = mix(col, kapton, soft(sr, 0.5));
  // The frame, the glass and the backlight.
  vec2 fl = l - vec2(0.0, 8.0);
  float sf = sdRound(fl, vec2(54.0, 29.0), 1.5);
  col *= shadowOf(sf - 1.0);
  col = mix(col, shade(gDk ? vec3(0.36, 0.37, 0.39) : vec3(0.72, 0.73, 0.75), fl, sf, 0.7), soft(sf, 0.5));
  col = mix(col, vec3(0.08, 0.09, 0.08), soft(abs(sdBox(fl, vec2(51.0, 26.0))) - 0.5, 0.5) * 0.6);
  float sw = sdBox(fl, vec2(50.0, 25.5));
  vec3 back = (gDk ? vec3(0.34, 0.50, 0.07) : vec3(0.66, 0.78, 0.26)) * (0.78 + 0.3 * gK) * (0.94 + 0.06 * smoothstep(30.0, -30.0, fl.x));
  col = mix(col, back, soft(sw, 0.5));
  vec2 sp = (l - vec2(-48.0, -16.0)) / SCR_PX;
  if (sp.x >= 0.0 && sp.x < 48.0 && sp.y >= 0.0 && sp.y < 24.0) {
    ivec2 ip = ivec2(floor(sp));
    int rowTop = 23 - ip.y;
    int tr = rowTop / 6, ry = rowTop - tr * 6;
    int c = ip.x / 4, cx = ip.x - c * 4;
    float on = ry < 5 && cx < 3 ? glyphBit(lcdChar(tr, c), cx, ry) : 0.0;
    vec3 ink = vec3(0.05, 0.09, 0.03);
    float dark = max(on * 0.9, 0.05) * dots(sp, vis);
    col = mix(col, ink, dark);
  }
  sil = max(sil, label(l - vec2(-52.0, -39.0), ${circuitLabel('LCD')}));
}

// A seven-segment digit, l from its centre: the lit share of each segment fades from the old digit to the new one.
// Returns (lit coverage, any-segment coverage).
vec2 digit7(vec2 l, int a, int b, float m) {
  l.x -= l.y * 0.12;
  float lit = 0.0, anyc = 0.0;
  const float W = 3.2, H = 6.0, G = 0.9;
  for (int k = 0; k < 7; k++) {
    vec2 p0, p1;
    if (k == 0) { p0 = vec2(-W + G, H); p1 = vec2(W - G, H); }
    else if (k == 1) { p0 = vec2(W, H - G); p1 = vec2(W, G); }
    else if (k == 2) { p0 = vec2(W, -G); p1 = vec2(W, -H + G); }
    else if (k == 3) { p0 = vec2(-W + G, -H); p1 = vec2(W - G, -H); }
    else if (k == 4) { p0 = vec2(-W, -G); p1 = vec2(-W, -H + G); }
    else if (k == 5) { p0 = vec2(-W, H - G); p1 = vec2(-W, G); }
    else { p0 = vec2(-W + G, 0.0); p1 = vec2(W - G, 0.0); }
    float cov = soft(sdSeg(l, p0, p1) - 0.85, 0.45);
    float st = mix(float((SEG7[a] >> k) & 1), float((SEG7[b] >> k) & 1), m);
    lit = max(lit, cov * st);
    anyc = max(anyc, cov);
  }
  return vec2(lit, anyc);
}

// The SYS group: a four-digit counter of bars played, the LOW bar graph and three status LEDs.
void sysGroup(inout vec3 col, inout float sil, vec2 l) {
  // The seven-segment module behind its red filter.
  vec2 dl = l - vec2(-22.0, 11.0);
  float sb = sdBox(dl, vec2(31.0, 12.5));
  col *= shadowOf(sb - 1.0);
  col = mix(col, shade(vec3(0.03, 0.03, 0.035), dl, sb, 0.6), soft(sb, 0.5));
  float swin = sdBox(dl, vec2(28.0, 9.5));
  col = mix(col, vec3(0.10, 0.012, 0.012), soft(swin, 0.5));
  float kd = floor((dl.x + 25.0) / 12.5);
  if (kd >= 0.0 && kd < 4.0) {
    float pw = kd < 0.5 ? 1000.0 : kd < 1.5 ? 100.0 : kd < 2.5 ? 10.0 : 1.0;
    int a = int(mod(floor(uSeg.x / pw), 10.0)), b = int(mod(floor(uSeg.y / pw), 10.0));
    vec2 d = digit7(dl - vec2(-18.75 + kd * 12.5, 0.0), a, b, uSeg.z);
    col = mix(col, vec3(0.22, 0.03, 0.02), d.y * soft(swin, 0.5));
    col = mix(col, vec3(1.0, 0.30, 0.20), d.x);
    gEmit += C_RED * d.x * gK * 0.6;
  }
  sil = max(sil, label(l - vec2(-53.0, 25.0), ${circuitLabel('BARS')}));
  // The LOW bar graph: ten segments, green to amber to red, the top one fading as the value passes it.
  vec2 bl = l - vec2(-22.0, -13.0);
  float sbb = sdBox(bl, vec2(30.5, 5.0));
  col *= shadowOf(sbb - 1.0);
  col = mix(col, shade(vec3(0.06, 0.06, 0.065), bl, sbb, 0.6), soft(sbb, 0.5));
  float ks = clamp(floor((bl.x + 29.0) / 5.8), 0.0, 9.0);
  vec2 sl = bl - vec2(-26.1 + ks * 5.8, 0.0);
  float seg = soft(sdBox(sl, vec2(1.9, 3.3)), 0.45);
  float on = smoothstep(ks * 0.1 - 0.025, ks * 0.1 + 0.125, uLow);
  vec3 sc = ks < 6.5 ? C_GRN : ks < 8.5 ? C_AMB : C_RED;
  col = mix(col, mix(sc * 0.24 + 0.07, mix(sc, vec3(1.0), 0.25), on), seg);
  gEmit += sc * on * seg * gK * 0.35;
  gHalo += vec4(sc, 1.0) * on * gK * 0.18 * exp(-sl.y * sl.y / 30.0) * step(3.3, abs(sl.y)) * step(abs(bl.x), 30.0);
  sil = max(sil, label(l - vec2(-53.0, -27.0), ${circuitLabel('LOW')}));
  // Status LEDs with their silk.
  led(col, l - vec2(19.0, 16.0), C_GRN, ind(0));
  led(col, l - vec2(19.0, 4.0), C_BLU, ind(1));
  led(col, l - vec2(19.0, -8.0), C_RED, ind(2));
  sil = max(sil, label(l - vec2(26.0, 14.0), ${circuitLabel('PWR')}));
  sil = max(sil, label(l - vec2(26.0, 2.0), ${circuitLabel('SYNC')}));
  sil = max(sil, label(l - vec2(26.0, -10.0), ${circuitLabel('CLIP')}));
}

// The IO group: a shrouded 2x5 header, eight channel LEDs that light as the whole mix climbs over its mean, and
// TX, RX and ACT.
void ioGroup(inout vec3 col, inout float sil, vec2 l) {
  vec2 hl = l - vec2(-37.0, -1.0);
  float sb = sdBox(hl, vec2(16.5, 9.0));
  col *= shadowOf(sb - 1.0);
  col = mix(col, shade(vec3(0.04, 0.04, 0.045), hl, sb, 0.7), soft(sb, 0.5));
  col = mix(col, vec3(0.015), soft(sdBox(hl, vec2(14.0, 6.5)), 0.5));
  col = mix(col, vec3(0.04, 0.04, 0.045), soft(sdBox(hl - vec2(0.0, -8.0), vec2(3.5, 1.5)), 0.4));
  vec2 pl = vec2(mod(hl.x + 13.5, 5.4) - 2.7, abs(hl.y) - 2.7);
  float pin = soft(sdBox(pl, vec2(1.1)), 0.4) * step(abs(hl.x), 13.5);
  col = mix(col, gDk ? vec3(0.62, 0.48, 0.20) : vec3(0.96, 0.78, 0.36), pin);
  sil = max(sil, label(l - vec2(-53.0, 12.0), ${circuitLabel('P3')}));
  // The channel row, standing LEDs.
  float kc = clamp(floor((l.x + 15.5) / 7.0), 0.0, 7.0);
  vec2 cl = l - vec2(-12.0 + kc * 7.0, 9.0);
  led(col, cl.yx, kc < 5.5 ? C_GRN : C_AMB, ind(6 + int(kc)));
  sil = max(sil, label(cl - vec2(-1.0, 6.0), kc + 63.0 * (64.0 + 4096.0 + 262144.0)));
  // TX, RX, ACT.
  float kt = clamp(floor((l.x + 4.0) / 15.0), 0.0, 2.0);
  vec2 tl = l - vec2(-4.0 + 15.0 * kt + 7.5, -11.0);
  led(col, tl, kt < 0.5 ? C_GRN : C_AMB, ind(kt < 0.5 ? 4 : kt < 1.5 ? 5 : 3));
  float tlab = kt < 0.5 ? ${circuitLabel('TX')} : kt < 1.5 ? ${circuitLabel('RX')} : ${circuitLabel('ACT')};
  sil = max(sil, label(tl - vec2(-5.0, -11.0), tlab));
}

// The age at which burst i reached the lane with hash lh (the step whose share first covers the lane's rank), or
// -1 when the burst never takes it. A lane joining late starts at the leads.
float joinAge(float lh, vec4 b, vec4 z) {
  float r = fract(lh + b.z);
  return r < z.x ? 0.0 : r < z.y ? b.w : r < z.z ? z.w : -1.0;
}

// Lane L of chip side sd, from the chip edge: the jog's start a and size M, its direction sg and the lane's end E.
// The side's fit shortens the whole lane past the leads, so the jog stays at 45 degrees; a module in the lane's
// way ends it short of the module.
vec4 laneGeom(float sd, float L, float dd0, float cw, float pitch) {
  float k = uFit[int(sd)];
  float b = floor((L + LANES) / (0.5 * LANES));
  float ha = hash21(vec2(sd * 7.0 + b, 1.3)), hc = hash21(vec2(sd * 7.0 + b, 5.1));
  float a = dd0 + k * (BUS_A * cw + JOG_HASH * cw * ha), M = k * pitch * (1.0 + 3.0 * hc);
  float E = a + M + k * (LANE_MIN * cw + LANE_SPAN * cw * hash21(vec2(sd * 31.0 + L, 8.8)));
  float sg = b < 2.0 ? 1.0 : -1.0;
  float vE = (L + 0.5) * pitch + sg * M;
  for (int i = 0; i < 4; i++) {
    if (uMod[i].z < 0.5) continue;
    vec2 m = uMod[i].xy - gCC, hb = MOD_HALF[i] * uMod[i].w;
    bool hz = sd < 1.5;
    float md = (hz ? m.x : m.y) * (sd == 1.0 || sd == 3.0 ? -1.0 : 1.0) - gH, mv = hz ? m.y : m.x;
    float hd = hz ? hb.x : hb.y, hv = hz ? hb.y : hb.x;
    if (abs(vE - mv) < hv + 0.5 * pitch && md - hd - 8.0 * gU < E && md + hd > a + M) E = max(md - hd - 8.0 * gU, a + M + 4.0 * gU);
  }
  return vec4(a, M, sg, E);
}

// Whether a component cell of half size hc, centred at c from the chip centre, would cover a bus lane.
bool onLane(vec2 c, float hc, float H, float dd0, float cw, float pitch) {
  vec2 ac = abs(c);
  bool hz = ac.x > ac.y;
  float dC = (hz ? ac.x : ac.y) - H, vC = hz ? c.y : c.x;
  float sd = hz ? (c.x > 0.0 ? 0.0 : 1.0) : (c.y > 0.0 ? 2.0 : 3.0);
  if (abs(vC) > H + hc) return false;
  for (float L = -LANES; L < LANES; L += 1.0) {
    vec4 g = laneGeom(sd, L, dd0, cw, pitch);
    float vL = (L + 0.5) * pitch, vE = vL + g.z * g.y;
    if (dC - hc < g.w + 0.3 * hc && vC + hc > min(vL, vE) - 0.4 * pitch && vC - hc < max(vL, vE) + 0.4 * pitch) return true;
  }
  return false;
}

void main() {
  vec2 fc = gl_FragCoord.xy;
  vec2 p = fc / uDpr, sz = uRes / uDpr, cc = coverCenter() / uDpr;
  float cw = uCover.z / uDpr;
  // One design pixel in css px (circuitUnit): the board scales with the cover.
  float u = max(cw / ${DESIGN_CW}.0, min(sz.x, sz.y) / ${DESIGN_STAGE}.0);
  float hu = hushAt(fc);
  float det = 1.0 - 0.8 * hu;
  bool dk = uLight < 0.5;
  gDk = dk;
  gEmit = vec3(0.0);
  gHalo = vec4(0.0);
  float scale = 0.75 + 0.5 * uGlow;
  gK = 0.7 + 0.4 * uGlow;
  float vis = 0.0;
  float H = CHIP_H * cw;
  gCC = cc;
  gH = H;
  gU = u;
  vec2 q = p - cc;
  vec2 aq = abs(q);
  bool horiz = aq.x > aq.y;
  float d = (horiz ? aq.x : aq.y) - H;
  float v = horiz ? q.y : q.x;
  float side = horiz ? (q.x > 0.0 ? 0.0 : 1.0) : (q.y > 0.0 ? 2.0 : 3.0);
  float pitch = (2.0 * H - 0.14 * cw) / (2.0 * LANES);
  vec3 maskc = dk ? vec3(0.008, 0.035, 0.100) : vec3(0.020, 0.520, 0.300);
  vec3 copper = dk ? vec3(0.030, 0.230, 0.380) : vec3(0.050, 0.720, 0.440);
  vec3 silkc = dk ? vec3(0.62, 0.66, 0.64) : vec3(0.97, 0.98, 0.95);
  vec3 goldc = dk ? vec3(0.62, 0.48, 0.20) : vec3(0.96, 0.78, 0.36);
  vec3 pulseC = vec3(0.10, 1.0, 1.0);
  vec3 pulseM = dk ? vec3(1.0, 0.10, 0.85) : vec3(1.0, 0.0, 0.55);
  if (!dk) pulseC = vec3(0.0, 0.35, 1.0);
  // Under the chip nothing of the board shows, so the board is drawn only around it.
  float sdC = sdBox(q, vec2(H - 7.0 * u)) - 7.0 * u;
  vec3 col = maskc;
  // Where a module sits, kept for the mounting holes, which a module in a stage corner covers.
  float modKeep = 0.0;
  if (sdC > -1.5) {
    // -- The module the pixel is in, if any, and whether this pixel's component cell is kept clear for one --
    int mk = -1;
    vec2 ml = vec2(0.0);
    float cellW = CELL * u;
    vec2 ci = floor(p / cellW);
    vec2 cellP = (ci + 0.5) * cellW;
    float keep = 0.0;
    bool cellFree = true;
    for (int i = 0; i < 4; i++) {
      if (uMod[i].z < 0.5) continue;
      // A module is drawn at its own scale, the one the layout found room for.
      float ms = uMod[i].w;
      vec2 l = p - uMod[i].xy;
      vec2 hb = MOD_HALF[i] * ms;
      if (abs(l.x) < hb.x + 10.0 * ms && abs(l.y) < hb.y + 10.0 * ms) { mk = i; ml = l / ms; vis = smoothstep(2.6, 3.8, SCR_PX * ms * uDpr); }
      keep = max(keep, soft(sdBox(l, hb + 5.0 * ms), 2.5 * ms));
      vec2 lc2 = abs(cellP - uMod[i].xy) - hb;
      if (max(lc2.x, lc2.y) < 24.0 * u) cellFree = false;
    }
    // -- Board: mask with a faint weave, copper pour at the edges, a loose routing of traces --
    float weave = vnoise(p * 0.9) * 0.5 + vnoise(p * 0.21) * 0.5;
    col = maskc * (0.92 + 0.16 * weave);
    float pour = smoothstep(0.58, 0.64, fbm(p * 0.006 + 3.1));
    vec2 hp = vec2(p.x + p.y, p.x - p.y);
    float hatch = smoothstep(0.55, 0.30, abs(fract(hp.x / 4.2) - 0.5) * 1.0) * 0.5 + smoothstep(0.55, 0.30, abs(fract(hp.y / 4.2) - 0.5)) * 0.5;
    col = mix(col, copper * 0.75, pour * (0.35 + 0.35 * hatch) * det);
    vec3 under = col;
    float away = smoothstep(COMP_FROM * 0.6 * cw, COMP_FROM * cw, max(aq.x, aq.y) - H);
    float tp = 10.0 * u;
    float row = floor(p.y / tp), colm = floor(p.x / tp);
    float seg = floor((p.x + hash11(row) * 190.0 * u) / (170.0 * u)), segv = floor((p.y + hash11(colm + 40.0) * 190.0 * u) / (170.0 * u));
    float tH = step(hash21(vec2(row, seg)), 0.22) * (1.0 - smoothstep(0.9 * u, 1.7 * u, abs(p.y - (row + 0.5) * tp)));
    float tV = step(hash21(vec2(colm + 90.0, segv)), 0.18) * (1.0 - smoothstep(0.9 * u, 1.7 * u, abs(p.x - (colm + 0.5) * tp)));
    modKeep = keep;
    float bgTrace = max(tH, tV) * away * (1.0 - keep);
    col = mix(col, copper, bgTrace);
    // -- Components in cells clear of the bus lanes, except where a module sits --
    float dd0 = (LEAD_L + 5.0) * u;
    vec2 lc = p - cellP;
    vec2 cellc = cellP - cc;
    float distC = max(abs(cellc.x), abs(cellc.y)) - H;
    float sil = 0.0;
    if (distC > COMP_FROM * cw && cellFree && !onLane(cellc, 0.45 * cellW, H, dd0, cw, pitch)) {
      float s1;
      vec3 e0 = gEmit;
      vec4 h0 = gHalo;
      vec4 pt = part(lc / u, ci, s1);
      gEmit = mix(e0, gEmit, det);
      gHalo = mix(h0, gHalo, det);
      col = mix(col, pt.rgb * (dk ? 0.72 : 1.0), pt.a * det + pt.a * (1.0 - det) * 0.5);
      bgTrace *= 1.0 - pt.a;
      sil = s1 * det;
      float lab = silkText(p / u, cellP / u + vec2(-6.0, 11.0), 3.0, hash21(ci) * 90.0) * step(0.45, hash21(ci + 2.2)) * det;
      sil = max(sil, lab);
    }
    // -- A full burst's front through the loose routing, and the surge's wave over the whole board --
    // Each share step adds its part of the front from the leads at the age it was reached, so none pops in mid-way.
    float dr = max(aq.x, aq.y) - H - dd0;
    float wave = 0.0;
    for (int i = 0; i < ${BURST_SLOTS}; i++) {
      vec4 b = uBurst[i], z = uBurstZ[i];
      if (b.y <= 0.0) continue;
      vec3 f = smoothstep(0.9, 1.0, z.xyz);
      vec3 x = (dr - (b.x - vec3(0.0, b.w, z.w)) * BURST_SPEED * cw) / (0.08 * cw);
      vec3 g = exp(-x * x) * step(vec3(0.0, b.w, z.w), vec3(b.x));
      wave += b.y * dot(vec3(f.x, f.y - f.x, f.z - f.y), g);
    }
    float sx = (dr - uSurge.x * SURGE_SPEED * cw) / (0.14 * cw);
    float surgeF = uSurge.y * exp(-sx * sx);
    // -- The bus: 16 leads a side fan out in four buses of four, each with its own jog and end vias --
    vec3 busAdd = vec3(0.0);
    if (d > 0.0 && d < BUS_REACH * cw) {
      float Lf = clamp(floor(v / pitch), -LANES, LANES - 1.0);
      for (int it = 0; it < 2; it++) {
        vec4 g = laneGeom(side, Lf, dd0, cw, pitch);
        Lf = clamp(floor((v - g.z * g.y * clamp((d - g.x) / g.y, 0.0, 1.0)) / pitch), -LANES, LANES - 1.0);
      }
      float best = 1e3, bestV = 0.0, bestE = 100.0;
      vec2 pp = vec2(d, v);
      vec3 vias[3];
      for (int k = -1; k <= 1; k++) {
        float L = clamp(Lf + float(k), -LANES, LANES - 1.0);
        vec4 g = laneGeom(side, L, dd0, cw, pitch);
        float a = g.x, M = g.y, sg = g.z, E = g.w;
        float vL = (L + 0.5) * pitch;
        float s1 = sdSeg(pp, vec2(dd0, vL), vec2(a, vL));
        float s2 = sdSeg(pp, vec2(a, vL), vec2(a + M, vL + sg * M));
        float s3 = sdSeg(pp, vec2(a + M, vL + sg * M), vec2(E, vL + sg * M));
        float dist = min(min(s1, s2), s3);
        if (dist < best) { best = dist; bestV = L; bestE = E; }
        vias[k + 1] = vec3(E, vL + sg * M, L);
      }
      // The loose routing passes under the bus lanes with a gap either side.
      // Trace half width: legible at pixel ratio 1 on a small cover, never over a third of the pitch.
      float tw = min(max(0.13 * pitch, 2.0 * u), 0.3 * pitch);
      float erase = bgTrace * (1.0 - smoothstep(tw + 2.0 * u, tw + 4.0 * u, best)) * step(d, bestE + 6.0 * u);
      col = mix(col, under, erase);
      bgTrace *= 1.0 - erase;
      // The via at the end of each lane: it sparks as a trickle comet or a burst lands.
      for (int k = 0; k < 3; k++) {
        float L = vias[k].z, E = vias[k].x;
        float vr = length(pp - vias[k].xy) / u;
        float ring = soft(vr - 4.6, 0.7);
        vec3 vcol = mix(goldc, vec3(0.01, 0.02, 0.02), soft(vr - 1.8, 0.5));
        float hv = step(0.5, hash21(vec2(L + side * 40.0, 3.3)));
        col = mix(col, vcol, ring * hv);
        float lh = hash21(vec2(L, side * 9.0 + 2.0));
        float arrive = smoothstep(0.86, 1.0, fract(uPk + lh * 3.7)) * smoothstep(1.0 - uLanes, 1.08 - uLanes, lh);
        float land = 0.0;
        for (int i = 0; i < ${BURST_SLOTS}; i++) {
          vec4 b = uBurst[i];
          float ja = joinAge(lh, b, uBurstZ[i]);
          if (b.y <= 0.0 || ja < 0.0) continue;
          float head = dd0 + (b.x - ja) * BURST_SPEED * cw;
          land += b.y * smoothstep(E - 12.0 * u, E, head) * exp(-max(head - E, 0.0) / (0.5 * cw));
        }
        col += mix(pulseC, pulseM, step(0.5, hash21(vec2(L, 7.7)))) * exp(-vr * vr / 14.0) * (arrive * 0.9 + land * 1.6) * scale * det;
      }
      float Lh = hash21(vec2(bestV, side * 9.0 + 2.0));
      float tm = soft(best - tw, 0.7);
      col = mix(col, copper, tm);
      col += (dk ? vec3(0.03, 0.10, 0.07) : vec3(0.05, 0.12, 0.08)) * soft(best - 0.4 * tw, 0.6) * tm;
      vec3 lanec = mix(pulseC, pulseM, step(0.5, hash21(vec2(bestV, 7.7))));
      // The trickle: slow comets on a share of the lanes; a lane fades in or out as the share moves.
      float dp = fract(uPk + Lh * 3.7) * (bestE + 16.0 * u);
      float trickle = (d <= dp ? exp(-(dp - d) / (36.0 * u)) : exp(-(d - dp) / (3.0 * u))) * smoothstep(1.0 - uLanes, 1.08 - uLanes, Lh);
      // The bursts: a head runs out from the leads with a tail behind it and stops at the lane's end.
      float burst = 0.0;
      for (int i = 0; i < ${BURST_SLOTS}; i++) {
        vec4 b = uBurst[i];
        float ja = joinAge(Lh, b, uBurstZ[i]);
        if (b.y <= 0.0 || ja < 0.0) continue;
        float head = min(dd0 + (b.x - ja) * BURST_SPEED * cw, bestE);
        burst += b.y * (d <= head ? exp(-(head - d) / (BURST_TAIL * cw)) : exp(-(d - head) / (3.0 * u))) * step(d, bestE + 4.0 * u);
      }
      busAdd = lanec * (trickle * 0.8 + burst + surgeF * 1.2) * (tm + 0.30 * exp(-best / (3.5 * u))) * scale * (dk ? 1.2 : 1.0);
      // The lead pad where the lead lands on the board.
      float lv = mod(v / pitch + LANES, 1.0) - 0.5;
      float pad = soft(max(abs(lv) * pitch - 0.30 * pitch, abs(d - (LEAD_L + 1.0) * u) - 4.0 * u), 0.5);
      col = mix(col, goldc, pad * 0.9);
    }
    col += pulseC * (bgTrace * (wave * 0.9 + surgeF * 1.4) + surgeF * 0.08) * scale * det;
    col += busAdd;
    // -- Silkscreen, then the modules on top of the board --
    if (mk == 0) dspModule(col, sil, ml, vis);
    else if (mk == 1) regModule(col, sil, ml, vis);
    else if (mk == 2) sysGroup(col, sil, ml);
    else if (mk == 3) ioGroup(col, sil, ml);
    col = mix(col, silkc, clamp(sil, 0.0, 1.0) * 0.85);
    // Light from the LEDs and screens: added in the dark; by day the halo tints the mask instead of washing it out.
    if (dk) col += gEmit + gHalo.rgb;
    else {
      vec3 hc = gHalo.a > 1e-4 ? gHalo.rgb / gHalo.a : vec3(0.0);
      col = mix(col, hc * 0.85 + 0.12, clamp(gHalo.a * 0.6, 0.0, 0.55));
      col += gEmit * 0.3;
    }
    // A cut dims the board around the chip; less by day, where the pale board would swing much further.
    col *= 1.0 - (dk ? CUT_DIM : 0.5 * CUT_DIM) * uDark;
  }
  // -- The chip: shadow, body, heat-spreader rim, the cover lid, leads, pin 1 --
  col *= 1.0 - 0.5 * exp(-max(sdC, 0.0) / (9.0 * u)) * (1.0 - smoothstep(0.0, 1.0, -sdC));
  float chip = soft(sdC, 0.8);
  // The leads: metal tongues along every side, drawn before the body so the body covers their roots. They glow
  // as a burst leaves the chip.
  float inLead = step(-5.0 * u, d) * step(d, LEAD_L * u);
  float lvl = mod(v / pitch + LANES, 1.0) - 0.5;
  float leadM = soft(abs(lvl) * pitch - 0.23 * pitch, 0.5) * soft(abs(d - ((LEAD_L - 5.0) * 0.5 - 2.0) * u) - (LEAD_L + 5.0) * 0.5 * u, 0.5) * step(abs(v), H - 0.06 * cw);
  vec3 leadc = (dk ? vec3(0.55, 0.57, 0.60) : vec3(0.80, 0.82, 0.85)) * (0.75 + 0.3 * smoothstep(0.25, 0.0, abs(lvl)));
  col = mix(col, leadc, leadM * (1.0 - chip) * inLead);
  col += pulseC * leadM * (1.0 - chip) * inLead * uLaunch * scale;
  // The body, the rim and the cover lid, only where the chip is: the cover read and the rim text cost the most.
  if (sdC < 1.0) {
    float pin1 = soft(length(q - vec2(-H + 22.0 * u, H - 22.0 * u)) - 4.0 * u, 0.5);
    vec3 plastic = shade(vec3(0.030, 0.034, 0.040), q, sdC, 0.8) + 0.02;
    float lidSd = sdBox(q, vec2(0.5 * cw)) - 2.0;
    float lidM = soft(lidSd, 0.8);
    vec3 lid = coverAt(q / cw + 0.5, 0.0) * (dk ? 0.9 : 1.0);
    vec3 rimc = plastic + (dk ? vec3(0.05, 0.055, 0.06) : vec3(0.10, 0.11, 0.12)) * smoothstep(8.0, 0.0, -sdC);
    rimc = mix(rimc, plastic * 0.55, soft(abs(lidSd) - 1.0, 0.7));
    vec3 chipc = mix(rimc, lid, lidM);
    vec2 pu = p / u, cu = cc / u;
    float cwu = cw / u;
    float rimTxt = silkText(pu, cu + vec2(-0.5 * cwu + 14.0, 0.5 * cwu + 7.0), 18.0, 3.0) * 0.8 + silkText(pu, cu + vec2(0.5 * cwu - 88.0, -0.5 * cwu - 14.0), 20.0, 8.0) * 0.8;
    chipc = mix(chipc, silkc * 0.9, rimTxt * (1.0 - lidM) * chip);
    chipc = mix(chipc, silkc, pin1 * (1.0 - lidM));
    col = mix(col, chipc, chip);
  }
  // -- Mounting holes in the stage corners --
  vec2 mh = (min(p, sz - p) - 26.0 * u) / u;
  float hr = length(mh);
  float ringM = soft(hr - 13.0, 0.8);
  col = mix(col, mix(goldc * 0.9, vec3(0.01, 0.015, 0.015), soft(hr - 7.0, 0.8)), ringM * step(max(mh.x, mh.y), 30.0) * step(mh.x, 8.0) * step(mh.y, 8.0) * (1.0 - modKeep));
  col = hushed(col, hu, 0.35);
  outColor = vec4(settle(col, fc), 1.0);
}`;

// The four modules: pocket (which corner of the chip), half size (the shader's MOD_HALF), and how far a designer
// would set each one back from the chip when there is room, in design px.
const CIRCUIT_MODS = [
  // DSP OLED, top right
  { sx: 1, sy: 1, hw: 54, hh: 33, push: [10, 4] },
  // REG LCD, bottom left
  { sx: -1, sy: -1, hw: 54, hh: 39, push: [4, 16] },
  // SYS, top left
  { sx: -1, sy: 1, hw: 56, hh: 30, push: [6, 10] },
  // IO, bottom right
  { sx: 1, sy: -1, hw: 56, hh: 26, push: [22, 8] },
] as const;

/** The stage in css px around the chip: its centre, cover width, half size, lane pitch, lead run and design px. */
function circuitFrame(geo: Geometry, size: { w: number; h: number; dpr: number }) {
  const r = size.dpr;
  const W = size.w / r;
  const Ht = size.h / r;
  const cw = geo.cover[2] / r;
  const u = circuitUnit(cw, W, Ht);
  const H = CHIP_H * cw;
  return {
    W,
    Ht,
    cw,
    cx: (geo.cover[0] + geo.cover[2] / 2) / r,
    cy: (geo.cover[1] + geo.cover[3] / 2) / r,
    u,
    H,
    pitch: (2 * H - 0.14 * cw) / (2 * LANES),
    dd0: (LEAD_L + 5) * u,
    floor: (geo.floor ?? 0) / r + 16,
  };
}

/** The longest a lane can run past its leads at full fit: the run before the jog, the jog, the run after it. */
function laneSpan(cw: number, pitch: number): number {
  return (BUS_A + JOG_HASH + LANE_MIN + LANE_SPAN) * cw + 4 * pitch;
}

/**
 * Each side's lane length factor into `out` (right, left, top, bottom): a side's lanes are shortened, jogs and
 * all, so the longest of them ends inside the stage, and below the chip above the transport. MIN_FIT is the floor
 * for a side with next to no room.
 */
export function circuitFit(geo: Geometry, size: { w: number; h: number; dpr: number }, out: Float32Array): Float32Array {
  const f = circuitFrame(geo, size);
  const room = [f.W - (f.cx + f.H), f.cx - f.H, f.Ht - (f.cy + f.H), f.cy - f.H - f.floor];
  const span = laneSpan(f.cw, f.pitch);
  room.forEach((m, i) => {
    out[i] = Math.min(1, Math.max(MIN_FIT, (m - f.dd0 - LANE_PAD * f.u) / span));
  });
  return out;
}

/** How far a side's lanes reach past the chip edge at fit `k`, the end pad included: an upper bound for any lane. */
export function circuitReach(geo: Geometry, size: { w: number; h: number; dpr: number }, k: number): number {
  const f = circuitFrame(geo, size);
  return f.dd0 + k * laneSpan(f.cw, f.pitch) + LANE_PAD * f.u;
}

/**
 * Places the modules in the pockets between the chip's buses into `out` as css px, y up, x, y, shown and scale
 * per module: clear of the buses' fans, the text, the transport, the Player's queue and each other. A module
 * scales with the square root of the design px, and steps down to its plain size or a little under where the
 * pocket is tight; one that finds no room is left out rather than crowded. Lanes running on under a module end
 * short of it.
 */
export function layoutCircuitModules(
  geo: Geometry,
  size: { w: number; h: number; dpr: number },
  ambient: boolean,
  out: Float32Array,
): Float32Array {
  const f = circuitFrame(geo, size);
  const { W, Ht, cx, cy } = f;
  const M = 12;
  const fit = circuitFit(geo, size, new Float32Array(4));
  // The fan of each side: the leads, the run before the jog and the jog itself (right, left, top, bottom).
  const fan = [0, 1, 2, 3].map((i) => f.H + f.dd0 + fit[i] * ((BUS_A + JOG_HASH) * f.cw + 4 * f.pitch) + 6);
  const lanes = f.H + 6;
  const right = ambient ? W - M : W - 342;
  // The transport: its top is the floor; its width is centred on the cover in the Player, on the stage in ambient.
  const ctrl = ambient ? [W / 2 - 330, W / 2 + 330] : [cx - 300, cx + 300];
  const blocks = geo.hush.map(([x, y, w, h]) => [x / size.dpr - 16, y / size.dpr - 16, (x + w) / size.dpr + 16, (y + h) / size.dpr + 16]);
  blocks.push([ctrl[0], -1e4, ctrl[1], f.floor]);
  blocks.push([cx - fan[1], cy - lanes, cx + fan[0], cy + lanes], [cx - lanes, cy - fan[3], cx + lanes, cy + fan[2]]);
  const fits = (x: number, y: number, hw: number, hh: number) =>
    x - hw >= M &&
    x + hw <= right &&
    y - hh >= M &&
    y + hh <= Ht - M &&
    !blocks.some(([x0, y0, x1, y1]) => x + hw > x0 && x - hw < x1 && y + hh > y0 && y - hh < y1);
  const scales = [Math.sqrt(f.u), 1, 0.9].filter((s, i, a) => i === 0 || s < a[0]);
  out.fill(0);
  CIRCUIT_MODS.forEach((m, i) => {
    for (const s of scales) {
      const hw = m.hw * s;
      const hh = m.hh * s;
      const ix = cx + m.sx * (lanes + 8);
      const iy = cy + m.sy * (lanes + 8);
      const roomX = m.sx > 0 ? right - ix - 2 * hw : ix - M - 2 * hw;
      const roomY = m.sy > 0 ? Ht - M - iy - 2 * hh : iy - M - 2 * hh;
      const px = ix + m.sx * (hw + Math.max(0, Math.min(m.push[0] * s, roomX)));
      const py = iy + m.sy * (hh + Math.max(0, Math.min(m.push[1] * s, roomY)));
      const edgeY = m.sy > 0 ? Ht - M - hh : M + hh;
      const reach = m.sx > 0 ? fan[0] : fan[1];
      const cands = [
        [px, py],
        [ix + m.sx * hw, iy + m.sy * hh],
        [px, edgeY],
        [cx + m.sx * (reach + 10 + hw), edgeY],
      ];
      for (const [a, b] of cands) {
        const x = Math.round(a);
        const y = Math.round(b);
        if (fits(x, y, hw, hh)) {
          out.set([x, y, 1, s], i * 4);
          blocks.push([x - hw - 8, y - hh - 8, x + hw + 8, y + hh + 8]);
          return;
        }
      }
    }
  });
  return out;
}

/** One band's quick measure and its slow mean. */
interface BandMean {
  fast: number;
  slow: number;
}

/** Each band judged against the song's recent mean, 0..1. */
interface Activity {
  bass: number;
  mid: number;
  high: number;
  all: number;
}

const ACTIVITY_KEYS = ["bass", "mid", "high", "all"] as const;

/**
 * One beat burst: its age, the beat's weight so far, whether a surge sent it, its lane seed, and its share of the
 * lanes in up to three steps (`z`) with the ages the second and third were reached (`t`). A beat's weight rises in
 * at most two steps after the first frame as its bass lands; a lane joins at the step that first covers it.
 */
export interface Burst {
  age: number;
  weight: number;
  surge: boolean;
  seed: number;
  z: [number, number, number];
  t: [number, number];
  steps: number;
}

/** The scene's moving state. */
export interface CircuitBoardState {
  slow: number;
  clock: number;
  // The trickle comets' phase.
  pk: number;
  // Seconds until the next idle burst.
  idle: number;
  bursts: Burst[];
  burstN: number;
  // The beat burst whose weight is still being followed, and the clocks of the launches in the last second.
  following: Burst | null;
  launches: number[];
  // The clock of the last beat burst on every lane.
  lastFull: number;
  // Per slot: age, light, lane seed, second step's age; then the three step shares and the third step's age.
  burstPacked: Float32Array;
  burstZ: Float32Array;
  // The surge wave's age (negative when none runs) and strength; a surge waiting for the launch gap.
  surgeAge: number;
  surgeStr: number;
  surgePending: number;
  // The small parts' hit envelopes: bass, mids, highs.
  hits: Float32Array;
  // A cut's dimming, its target and how long the target holds.
  dark: number;
  darkTgt: number;
  darkHold: number;
  mean: Record<keyof Activity, BandMean> | null;
  beatN: number;
  lastBeat: number;
  beatRun: number;
  scroll: number;
  lastScroll: number;
  // The counter's previous and current value, and the fade between them.
  segPrev: number;
  segCur: number;
  segMix: number;
  field: number;
  low: number;
  lanes: number;
  tick: number;
  // The register bytes: bass, mids, highs, level.
  regs: Float32Array;
  regT: number;
  trace: Float32Array;
  traceV: number;
  traceAcc: number;
  bars: Float32Array;
  bands: Float32Array;
  // The commanded and shown indicator states, how long each has held, the flip timer and the round-robin cursor.
  cmd: number[] | null;
  val: Float32Array;
  held: Float32Array;
  flipWait: number;
  rr: number;
}

export function createCircuitBoardState(): CircuitBoardState {
  return {
    slow: 0,
    clock: 0,
    pk: 0,
    idle: 3.5,
    bursts: [],
    burstN: 0,
    following: null,
    launches: [],
    lastFull: -9,
    burstPacked: new Float32Array(BURST_SLOTS * 4),
    burstZ: new Float32Array(BURST_SLOTS * 4),
    surgeAge: -1,
    surgeStr: 0,
    surgePending: 0,
    hits: new Float32Array(3),
    dark: 0,
    darkTgt: 0,
    darkHold: 0,
    mean: null,
    beatN: 0,
    lastBeat: -9,
    beatRun: 0,
    scroll: 0,
    lastScroll: -9,
    segPrev: 0,
    segCur: 0,
    segMix: 1,
    field: 0,
    low: 0,
    lanes: CIRCUIT.IDLE_LANES,
    tick: 0,
    regs: new Float32Array(4),
    regT: 0,
    trace: new Float32Array(48).fill(0.4),
    traceV: 0.4,
    traceAcc: 0,
    bars: new Float32Array(16),
    bands: new Float32Array(24),
    cmd: null,
    val: new Float32Array(16),
    held: new Float32Array(16).fill(9),
    flipWait: 0,
    rr: 0,
  };
}

/** Each band against the song's recent mean: 0..1, zero under Calm and while paused. */
function circuitActivity(st: CircuitBoardState, s: VisualSignal, dt: number, drive: number): Activity {
  const C = CIRCUIT;
  const raw: Activity = { bass: s.bassMotion / 0.9, mid: s.midMotion / 0.75, high: s.highMotion / 0.75, all: (s.level - 0.12) / 0.5 };
  if (!st.mean) {
    const mean = {} as Record<keyof Activity, BandMean>;
    for (const k of ACTIVITY_KEYS) mean[k] = { fast: raw[k], slow: raw[k] };
    st.mean = mean;
  }
  const out: Activity = { bass: 0, mid: 0, high: 0, all: 0 };
  for (const k of ACTIVITY_KEYS) {
    const m = st.mean[k];
    m.fast = easeEnvelope(m.fast, raw[k], dt, C.FAST_TAU);
    m.slow = easeEnvelope(m.slow, raw[k], dt, C.SLOW_TAU);
    out[k] = drive > 0 ? clamp01(C.ABS * m.fast + (C.REL * (m.fast - m.slow)) / C.REL_SPAN) : 0;
  }
  return out;
}

/**
 * The indicator LEDs: each has a target from its role, with hysteresis; at most one flips per FLIP_GAP, each holds
 * its state FLIP_HOLD, and the shown state eases (0.35 s on, 0.6 s off). Order: PWR, SYNC, CLIP, ACT, TX, RX, CH0..7.
 */
function circuitIndicators(st: CircuitBoardState, dt: number, act: Activity, sync: boolean): void {
  const C = CIRCUIT;
  const hyst = (i: number, x: number, th: number) => ((st.cmd && st.cmd[i] ? x > th - 0.07 : x > th) ? 1 : 0);
  const tgt = [1, sync ? 1 : 0, hyst(2, act.all, 0.85), hyst(3, act.high, 0.45), hyst(4, act.mid, 0.3), hyst(5, act.mid, 0.6)];
  for (let k = 0; k < 8; k++) tgt.push(hyst(6 + k, act.all, 0.06 + k * 0.11));
  let cmd = st.cmd;
  if (!cmd) {
    cmd = st.cmd = tgt.slice();
    tgt.forEach((t, i) => {
      st.val[i] = t;
    });
  }
  for (let i = 0; i < tgt.length; i++) st.held[i] += dt;
  st.flipWait -= dt;
  if (st.flipWait <= 0) {
    for (let n = 0; n < tgt.length; n++) {
      const i = (st.rr + n) % tgt.length;
      if (tgt[i] !== cmd[i] && st.held[i] >= C.FLIP_HOLD) {
        cmd[i] = tgt[i];
        st.held[i] = 0;
        st.flipWait = C.FLIP_GAP;
        st.rr = i + 1;
        break;
      }
    }
  }
  for (let i = 0; i < tgt.length; i++) st.val[i] = easeEnvelope(st.val[i], cmd[i], dt, cmd[i] > st.val[i] ? C.LED_UP : C.LED_DOWN);
}

/** Moves `cur` toward `tgt` by at most `rate` a second. */
function slew(cur: number, tgt: number, rate: number, dt: number): number {
  return cur + Math.max(-rate * dt, Math.min(rate * dt, tgt - cur));
}

/** A burst's light from its beat's weight: a quiet beat near nothing, a full kick at BURST_LIGHT. */
export function burstLight(weight: number): number {
  return Math.min(CIRCUIT.BURST_LIGHT, 1.1 * Math.max(0, weight));
}

/**
 * The share of lanes a burst takes from its beat's weight at motion gain `gain`, judged before the gain so the
 * share reads the same at every reactivity: none for a quiet beat, a few for a kickless onset, about half to two
 * thirds for a typical loud kick, every lane only for the strongest.
 */
export function burstShare(weight: number, gain: number): number {
  const raw = Math.max(0, weight) / Math.max(1, gain);
  return raw >= SHARE_FULL ? 1 : SHARE_TOP * clamp01((raw - 0.05) / (SHARE_FULL - 0.05)) ** 1.2;
}

// The weight of an idle burst, sent on a timer when the board has no motion gain.
const IDLE_WEIGHT = 0.4;
// Loud masters pin many kicks at the top weight, so a kick takes every lane only when no burst has in the last
// FULL_GAP seconds; the others stay at SHARE_TOP.
const FULL_GAP = 3;

/** A beat burst's share with the full-board gap applied; records a full burst's clock. */
function shareNow(st: CircuitBoardState, weight: number, gain: number): number {
  const z = burstShare(weight, gain);
  if (z < 1) return z;
  if (st.clock - st.lastFull < FULL_GAP) return SHARE_TOP;
  st.lastFull = st.clock;
  return 1;
}

/** Raises a beat burst's weight as the beat's bass lands; a larger share opens a new step, at most two after the first. */
function followWeight(st: CircuitBoardState, b: Burst, weight: number, gain: number): void {
  b.weight = Math.max(b.weight, weight);
  if (b.steps >= 2 || b.z[b.steps] >= 1) return;
  const z = shareNow(st, b.weight, gain);
  if (z <= b.z[b.steps] + 1e-6) return;
  b.steps += 1;
  b.t[b.steps - 1] = b.age;
  for (let k = b.steps; k < 3; k++) b.z[k] = z;
}

/**
 * The beat bursts and the surge wave: a beat sends one burst whose weight follows the beat's as its bass lands; a
 * surge sends one on every lane above any beat's light, the wave, and lifts a cut's dim. At most three bursts
 * launch in any second: a surge with no slot free waits for one, and a beat with none free sends nothing. With no
 * gain an idle burst runs on a timer that restarts while the gain is on, so a switch to Calm or pause waits a full
 * interval for its first.
 */
function circuitBursts(st: CircuitBoardState, s: VisualSignal, dt: number, drive: number): void {
  const C = CIRCUIT;
  for (const b of st.bursts) b.age += dt;
  while (st.bursts.length > 0 && st.bursts[0].age >= C.BURST_LIFE) st.bursts.shift();
  if (st.following && (st.following.age >= C.WEIGHT_WINDOW || !st.bursts.includes(st.following))) st.following = null;
  const launch = (weight: number, surge: boolean): Burst => {
    if (st.bursts.length === BURST_SLOTS) st.bursts.shift();
    st.burstN += 1;
    st.launches.push(st.clock);
    const z0 = surge ? 1 : drive > 0 ? shareNow(st, weight, drive) : burstShare(weight, drive);
    const b: Burst = { age: 0, weight, surge, seed: (st.burstN * 0.618034) % 1, z: [z0, z0, z0], t: [0, 0], steps: 0 };
    st.bursts.push(b);
    return b;
  };
  while (st.launches.length > 0 && st.launches[0] <= st.clock - 1 + 1e-9) st.launches.shift();
  const open = st.launches.length < 3;
  if (st.surgeAge >= 0) st.surgeAge = st.surgeAge + dt < C.SURGE_LIFE ? st.surgeAge + dt : -1;
  if (drive > 0) {
    st.idle = IDLE_EVERY;
    if (s.surge > 0) st.surgePending = Math.max(st.surgePending, s.surge);
    if (st.surgePending > 0 && open) {
      launch(0, true);
      st.surgeAge = 0;
      st.surgeStr = Math.min(1, 0.6 + 0.4 * st.surgePending);
      st.surgePending = 0;
      st.darkTgt = 0;
      st.darkHold = 0;
    } else if (s.beat > 0 && open) st.following = launch(s.beatWeight, false);
    else if (st.following && s.beatWeight > 0) followWeight(st, st.following, s.beatWeight, drive);
  } else {
    st.surgePending = 0;
    st.following = null;
    st.idle -= dt;
    if (st.idle <= 0) {
      st.idle = IDLE_EVERY;
      launch(IDLE_WEIGHT, false);
    }
  }
  st.burstPacked.fill(0);
  st.burstZ.fill(0);
  st.bursts.forEach((b, i) => {
    const t = b.age / C.BURST_LIFE;
    const rise = Math.min(1, b.age / C.BURST_RISE);
    const light = (b.surge ? C.SURGE_LIGHT : burstLight(b.weight)) * rise * rise * (3 - 2 * rise) * (1 - t * t) ** 2;
    st.burstPacked.set([b.age, light * (1 - st.dark), b.seed, b.t[0]], i * 4);
    st.burstZ.set([b.z[0], b.z[1], b.z[2], b.t[1]], i * 4);
  });
}

/** The leads' glow as a burst leaves the chip: each share step's lanes glow over their first tenth of a second. */
function circuitLaunch(st: CircuitBoardState): number {
  let sum = 0;
  st.bursts.forEach((b, i) => {
    const light = st.burstPacked[i * 4 + 1];
    const at = [0, b.t[0], b.t[1]];
    for (let k = 0; k < 3; k++) {
      const share = b.z[k] - (k > 0 ? b.z[k - 1] : 0);
      if (share > 0 && b.age >= at[k]) sum += light * Math.min(1, 1.5 * share) * Math.exp(-(b.age - at[k]) / 0.1);
    }
  });
  return Math.min(1.5, sum);
}

/** The surge wave's light this frame: fades in over 0.05 s and out over SURGE_LIFE. */
function surgeLight(st: CircuitBoardState): number {
  if (st.surgeAge < 0) return 0;
  const t = st.surgeAge / CIRCUIT.SURGE_LIFE;
  return 1.5 * st.surgeStr * Math.min(1, st.surgeAge / 0.05) * (1 - t) ** 2;
}

/** Advances the board by dt at motion gain `drive` (0 under Calm and while paused). */
export function stepCircuitBoard(st: CircuitBoardState, s: VisualSignal, dt: number, drive: number): void {
  const C = CIRCUIT;
  st.slow += dt;
  st.clock += dt;
  // A cut dims the board and stills the trickle for a moment; a surge's burst lifts it at once (circuitBursts).
  if (drive > 0 && s.cut > 0) {
    st.darkTgt = Math.min(1, 0.4 + s.cut);
    st.darkHold = C.CUT_HOLD;
  }
  st.darkHold -= dt;
  if (drive === 0 || st.darkHold <= 0) st.darkTgt = 0;
  const lifted = st.darkTgt < st.dark && st.surgeAge >= 0;
  st.dark = easeEnvelope(st.dark, st.darkTgt, dt, st.darkTgt > st.dark ? C.CUT_IN : lifted ? C.CUT_LIFT : C.CUT_OUT);
  circuitBursts(st, s, dt, drive);
  // The small parts' hits: each group's envelope jumps on a hit and falls over HIT_TAU.
  const hit = [s.bassHit, s.midHit, s.highHit];
  for (let k = 0; k < 3; k++) st.hits[k] = Math.max(st.hits[k] * Math.exp(-dt / C.HIT_TAU), drive > 0 ? Math.min(1, hit[k]) : 0);
  // Beats: the bar counter and the register scroll.
  if (drive > 0 && s.beat > 0) {
    st.beatRun = st.clock - st.lastBeat < 1.2 ? st.beatRun + 1 : 1;
    st.lastBeat = st.clock;
    st.beatN += 1;
    if (st.beatN % 4 === 0) {
      st.segPrev = st.segCur;
      st.segCur = (st.segCur + 1) % 10000;
      st.segMix = 0;
    }
    if (st.clock - st.lastScroll > C.SCROLL_GAP) {
      st.scroll = (st.scroll + 1) % 15;
      st.lastScroll = st.clock;
    }
  }
  st.segMix = Math.min(1, st.segMix + dt / C.SEG_FADE);
  const sync = drive > 0 && st.beatRun >= 3 && st.clock - st.lastBeat < 2.5;
  const act = circuitActivity(st, s, dt, drive);
  st.field = slew(st.field, act.high, C.SLEW_FIELD, dt);
  st.low = slew(st.low, act.bass, C.SLEW_BAR, dt);
  // The trickle between beats: a thin share of the lanes that grows with the loudness, none near silence; a board
  // with no motion gain idles at IDLE_LANES. Its comets crawl, a lane in about ten seconds.
  const loud = clamp01((s.loudness - C.TRICKLE_FROM) / (C.TRICKLE_FULL - C.TRICKLE_FROM));
  st.lanes = slew(st.lanes, drive > 0 ? C.TRICKLE * loud * loud * (3 - 2 * loud) : C.IDLE_LANES, C.SLEW_LANES, dt);
  st.pk += dt * (drive > 0 ? (0.06 + 0.12 * s.loudness) * (1 - st.dark) : 0.08);
  // The OLED: a level trace scrolling at TRACE_HZ (bass and mids), sixteen bars from the bands; idle drift under Calm.
  const tv =
    drive > 0
      ? clamp01(0.1 + 0.8 * (0.55 * s.bassMotion + 0.45 * s.midMotion))
      : 0.4 + 0.1 * Math.sin(st.slow * 0.9) + 0.05 * Math.sin(st.slow * 2.3);
  st.traceV = easeEnvelope(st.traceV, tv, dt, 0.06);
  st.traceAcc += dt * C.TRACE_HZ;
  while (st.traceAcc >= 1) {
    st.traceAcc -= 1;
    st.trace.copyWithin(0, 1);
    st.trace[47] = st.traceV;
  }
  const bands = cyberBands(st.bands, s, drive, dt);
  for (let i = 0; i < 16; i++) {
    const j = Math.floor(i * 1.5);
    const tb = drive > 0 ? Math.max(bands[j], bands[Math.min(23, j + 1)]) : 0.14 + 0.1 * (0.5 + 0.5 * Math.sin(st.slow * 0.6 + i * 0.7));
    st.bars[i] = easeEnvelope(st.bars[i], tb, dt, tb > st.bars[i] ? 0.1 : 0.35);
  }
  // The LCD: live registers every REG_EVERY, the dump ticking with the highs.
  st.regT -= dt;
  if (st.regT <= 0) {
    st.regT = C.REG_EVERY;
    [act.bass, act.mid, act.high, s.level].forEach((x, i) => {
      st.regs[i] = Math.round(clamp01(x) * 255);
    });
  }
  st.tick += dt * (drive > 0 ? 0.5 + 4 * act.high : 0.3);
  circuitIndicators(st, dt, act, sync);
}

const CIRCUIT_BOARD_PROGRAM: ProgramSource = { name: "circuit-board", vs: FS_VS, fs: FS };
/** The programs circuit board compiles, for warming the shader cache ahead of the stage. */
export const CIRCUIT_BOARD_PROGRAMS: readonly ProgramSource[] = [CIRCUIT_BOARD_PROGRAM];

export function createCircuitBoard(kit: Kit): Candidate {
  const { gl } = kit;
  const art = createCoverTexture(gl);
  const st = createCircuitBoardState();
  const mods = new Float32Array(MODULES * 4);
  const fit = new Float32Array(4);

  return {
    mode: "image",
    bloom: 0,
    exposure: 1,
    inkGain: 1,
    trail: null,
    vignette: 0,
    draw(f: Frame) {
      if (!f.cover) return;
      art.sync(f.cover);
      const s = f.sig;
      stepCircuitBoard(st, s, f.dt, cyberGain(s, f.playing));
      layoutCircuitModules(kit.geo, kit.size, f.ambient, mods);
      circuitFit(kit.geo, kit.size, fit);
      const p = kit.program(CIRCUIT_BOARD_PROGRAM);
      setScene(kit, p, f, 0, null, art.tex);
      kit.set1(p, "uPk", st.pk);
      kit.set1(p, "uGlow", clamp01(0.25 + 0.9 * s.loudness));
      gl.uniform4fv(kit.uniform(p, "uBurst"), st.burstPacked);
      gl.uniform4fv(kit.uniform(p, "uBurstZ"), st.burstZ);
      gl.uniform4fv(kit.uniform(p, "uFit"), fit);
      gl.uniform2f(kit.uniform(p, "uSurge"), Math.max(0, st.surgeAge), surgeLight(st));
      gl.uniform3fv(kit.uniform(p, "uHit"), st.hits);
      kit.set1(p, "uDark", st.dark);
      kit.set1(p, "uLaunch", circuitLaunch(st));
      kit.set1(p, "uSlow", st.slow);
      gl.uniform4fv(kit.uniform(p, "uMod"), mods);
      gl.uniform4fv(kit.uniform(p, "uBars"), st.bars);
      gl.uniform4fv(kit.uniform(p, "uTrace"), st.trace);
      gl.uniform4fv(kit.uniform(p, "uInd"), st.val);
      gl.uniform3f(kit.uniform(p, "uSeg"), st.segPrev, st.segCur, st.segMix);
      kit.set1(p, "uLow", st.low);
      kit.set1(p, "uField", st.field);
      kit.set1(p, "uLanes", st.lanes * (1 - st.dark));
      gl.uniform4fv(kit.uniform(p, "uRegs"), st.regs);
      kit.set1(p, "uTick", st.tick);
      kit.set1(p, "uScroll", st.scroll);
      kit.set1(p, "uClock", st.clock);
      kit.set1(p, "uBeatN", (st.beatN + 3) % 4);
      kit.drawQuad();
    },
    dispose() {
      art.dispose();
    },
  };
}
