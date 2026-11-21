// Rings rush toward the viewer down a tunnel. The spectrum bends each ring's shape around its
// circumference; the slow bass swell sets the speed; the eased level sets the brightness. Script state
// keeps the travel, so the speed can change without the rings jumping.
const SPEEDS = { calm: 1, fast: 2.2 };

plistoVis.scene({
  mode: "glow",
  passes: [
    {
      name: "tunnel",
      fs: plistoVis.SCENE_PRELUDE + `
uniform float uTravel;
void main() {
  vec2 p = (gl_FragCoord.xy - coverCenter()) / uCover.z;
  float r = length(p);
  // The angle folded to 0..1: the low bands to the right, the high bands to the left, the halves above and
  // below the middle mirrored.
  float m = abs(atan(p.y, p.x)) / PI;
  float z = 0.35 / max(r, 0.02);
  float rz = z * 4.0 * (1.0 - band(m) * 0.2) + uTravel;
  float w = fwidth(rz) * 1.2;
  float ring = 1.0 - smoothstep(0.0, w + 0.05, abs(fract(rz) - 0.5));
  float fog = smoothstep(0.04, 0.5, r) * smoothstep(3.0, 1.2, r);
  vec3 col = pal(fract(z * 0.12 + uTravel * 0.04) * 2.0) * ring * fog * (0.3 + 0.7 * uLevel);
  outColor = vec4(col, 1.0);
}`,
    },
  ],
  init: () => ({ travel: 0 }),
  update(frame, state) {
    // A paused track and a still frame hold the tunnel where it is.
    if (!frame.playing || frame.still) return;
    state.travel += frame.dt * (0.15 + 0.5 * frame.sig.swell) * (SPEEDS[frame.settings.speed] || 1);
  },
  uniforms(pass, program, kit, frame, state) {
    kit.set1(program, "uTravel", state.travel);
  },
});
