// A candidate kind: a factory over the kit, written the way Plisto's own visualizers are. List the
// programs up front so they compile together before the first frame.
const PROGRAM = {
  name: "bars",
  vs: plistoVis.FS_VS,
  fs: plistoVis.PRELUDE + `
void main() {
  vec2 q = gl_FragCoord.xy / uRes;
  // One bar per band along the bottom half of the stage, with a gap between bars.
  float gap = step(0.15, fract(q.x * 24.0));
  float bar = step(q.y, band(q.x) * 0.5) * gap;
  outColor = vec4(pal(q.x * 2.0) * bar * (0.3 + 0.7 * uRms), 1.0);
}`,
};

plistoVis.candidate(
  (kit) => ({
    mode: "glow",
    bloom: 0,
    exposure: 1,
    inkGain: 1,
    trail: null,
    draw(frame) {
      const p = kit.program(PROGRAM);
      // Sets the common uniforms and uses the program.
      kit.setCommon(p, frame);
      kit.drawQuad();
    },
    dispose() {},
  }),
  { programs: [PROGRAM] },
);
