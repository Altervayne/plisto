/*
 * The shared kit for the cosmic visualizers: GLSL helpers spliced after the scene prelude, and the eased beat
 * impulse more than one scene moves things with. Every cosmic scene is dark-only and paints the whole stage.
 *
 * Photosensitivity: overall brightness follows the eased level. The envelopes and the beats move, bend,
 * drift or resize things, and any light they add is eased and local; nothing flashes. Every twinkle runs on a cycle of four seconds or longer.
 */

// -- Local Imports --
import { easeEnvelope } from "../../../../state/player/visualSignal";

/** Helpers a cosmic scene shader uses after `SCENE_PRELUDE`. */
export const COSMIC_COMMON = `
float sat(float x) { return clamp(x, 0.0, 1.0); }
vec2 rot2(vec2 p, float a) { float c = cos(a), s = sin(a); return vec2(c * p.x - s * p.y, s * p.x + c * p.y); }
// Sparse stars on a hashed grid, 0..1. Each twinkles on its own slow cycle (4 s or longer) and never goes out.
float stars(vec2 p, float cell, float share, float size) {
  vec2 id = floor(p / cell);
  vec2 f = p / cell - id;
  vec3 r = vec3(hash21(id + 1.7), hash21(id + 9.1), hash21(id + 23.3));
  float d = length((f - (0.2 + 0.6 * r.xy)) * cell);
  float tw = 0.75 + 0.25 * sin(uTime / (4.0 + 5.0 * r.x) + r.y * 40.0);
  return step(r.z, share) * exp(-pow(d / (size * (0.6 + 0.8 * r.x)), 2.0)) * tw * (0.35 + 0.65 * r.y);
}
// A zoom about c: the whole picture swells by k (eased on the script side, so it glides and never shakes).
vec2 zoomAbout(vec2 p, vec2 c, float k) { return c + (p - c) / (1.0 + k); }
// The cover, blurred by lod, read at a stage-space uv.
vec3 coverAt(vec2 uv, float lod) { return textureLod(uCoverTex, uv, lod).rgb; }
// Keeps hue and sets the lightness, so a dark cover still gives a bright tint.
vec3 lift(vec3 c, float l) { return c / max(luma(c), 0.05) * l; }
`;

// The punch's fall and rise time constants, in seconds.
const PUNCH_FALL_TAU = 0.55;
const PUNCH_RISE_TAU = 0.12;

/** The held and eased halves of a beat punch. */
export interface CosmicPunch {
  held: number;
  eased: number;
}

export function createCosmicPunch(): CosmicPunch {
  return { held: 0, eased: 0 };
}

/**
 * An eased beat impulse, 0 to 1.5: it rises over 0.12 s and falls over about half a second. A motion
 * channel that never drives brightness. The caller passes a beat already zeroed under Calm and when paused.
 */
export function cosmicPunch(st: CosmicPunch, beat: number, dt: number): number {
  st.held = Math.max(st.held * Math.exp(-dt / PUNCH_FALL_TAU), Math.min(1.5, beat));
  st.eased = easeEnvelope(st.eased, st.held, dt, PUNCH_RISE_TAU);
  return st.eased;
}
