// A scene kind: one fragment pass, plus a little script state. Scene helpers and the prelude come from
// `plistoVis`. `update` runs once per frame; `uniforms` sets this pass's own uniforms.
plistoVis.scene({
  mode: "glow",
  passes: [
    {
      name: "main",
      fs: plistoVis.SCENE_PRELUDE + `
uniform float uSpin;
void main() {
  vec2 p = (gl_FragCoord.xy - coverCenter()) / uCover.z;
  float a = atan(p.y, p.x) + uSpin;
  // Six spokes under a ring whose radius follows the eased level.
  float spoke = 0.5 + 0.5 * cos(a * 6.0);
  float ring = exp(-pow((length(p) - 0.9 - 0.25 * uLevel) / 0.08, 2.0));
  outColor = vec4(pal(spoke) * ring * (0.3 + 0.7 * uLevel), 1.0);
}`,
    },
  ],
  init: () => ({ spin: 0 }),
  update(frame, state) {
    // Turn faster on a swelling bass. A still frame and a paused track hold the angle.
    if (frame.playing && !frame.still) state.spin += frame.dt * (0.2 + 0.6 * frame.sig.swell);
  },
  uniforms(pass, program, kit, frame, state) {
    kit.set1(program, "uSpin", state.spin);
  },
});
