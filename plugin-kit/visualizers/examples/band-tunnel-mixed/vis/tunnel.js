// The band tunnel, tuned live by the control page. The page sends { type: "accent", value } to shift the
// colors and { type: "pulse" } for a short surge of speed. The tunnel reports
// { type: "energy", value, accent } a few times a second so the page can show it. Without a channel (still,
// thumbnail, visualizer-only run) it is the plain tunnel.
const SPEEDS = { calm: 1, fast: 2.2 };
const SHIFTS = { default: 0, warm: 0.3, cool: 0.65 };
const REPORT_EVERY = 0.25;
// The pulse may not push rings past a pixel faster than this many a second, so the surge never flickers.
// Fast at full swell already runs at 1.43 a second ((0.15 + 0.5) x 2.2); only the surge is capped.
const MAX_RING_RATE = 3;

plistoVis.scene({
  mode: "glow",
  passes: [
    {
      name: "tunnel",
      fs: plistoVis.SCENE_PRELUDE + `
uniform float uTravel;
uniform float uShift;
void main() {
  vec2 p = (gl_FragCoord.xy - coverCenter()) / uCover.z;
  float r = length(p);
  float m = abs(atan(p.y, p.x)) / PI;
  float z = 0.35 / max(r, 0.02);
  float rz = z * 4.0 * (1.0 - band(m) * 0.2) + uTravel;
  float w = fwidth(rz) * 1.2;
  float ring = 1.0 - smoothstep(0.0, w + 0.05, abs(fract(rz) - 0.5));
  float fog = smoothstep(0.04, 0.5, r) * smoothstep(3.0, 1.2, r);
  vec3 col = pal(fract(z * 0.12 + uTravel * 0.04 + uShift) * 2.0) * ring * fog * (0.3 + 0.7 * uLevel);
  outColor = vec4(col, 1.0);
}`,
    },
  ],
  init: () => ({ travel: 0, shift: 0, accent: "default", pulse: 0, sinceReport: 0, reported: -1, off: null }),
  update(frame, state) {
    state.live = frame.playing && !frame.still;
    // The channel is read in a frame, not at load. Subscribe once, then say hello: the page answers with
    // its accent, so a restarted tunnel picks the page's choice back up.
    if (!state.off && plistoVis.channel) {
      state.off = plistoVis.channel.onMessage((data) => {
        if (data && data.type === "accent" && Object.hasOwn(SHIFTS, data.value)) {
          state.accent = data.value;
          state.shift = SHIFTS[data.value];
          state.reported = -1;
        } else if (data && data.type === "pulse" && state.live) {
          state.pulse = 1;
        }
      });
      plistoVis.channel.send({ type: "hello" });
    }
    // A paused track and a still frame hold the tunnel where it is.
    if (!state.live) return;
    // The pulse is a speed surge that eases out in about a second; brightness is untouched.
    state.pulse = Math.max(0, state.pulse - frame.dt);
    const boost = 1 + 3 * state.pulse * state.pulse;
    const rate = (0.15 + 0.5 * frame.sig.swell) * (SPEEDS[frame.settings.speed] || 1);
    // Travel advances one ring per unit, so the rate is the rings a second passing a fixed pixel.
    state.travel += frame.dt * Math.max(rate, Math.min(rate * boost, MAX_RING_RATE));

    // At most four reports a second, and only when the level moved.
    state.sinceReport += frame.dt;
    const level = Math.round(frame.sig.level * 20) / 20;
    if (plistoVis.channel && state.sinceReport >= REPORT_EVERY && level !== state.reported) {
      state.sinceReport = 0;
      state.reported = level;
      plistoVis.channel.send({ type: "energy", value: level, accent: state.accent });
    }
  },
  uniforms(pass, program, kit, frame, state) {
    kit.set1(program, "uTravel", state.travel);
    kit.set1(program, "uShift", state.shift);
  },
  dispose(state) {
    if (state.off) state.off();
  },
});
