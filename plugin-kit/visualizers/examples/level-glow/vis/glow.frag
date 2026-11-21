// A soft disc of light around the cover. Its reach follows the eased level and its edge is shaped by the
// spectrum, so the sound changes the shape and the slow level sets the brightness. Nothing here reacts
// faster than `uLevel`, which cannot flash.
// The prelude provides uCover, uLevel, uPal, uSetting_tint (the Tint setting, a vec3) and
// uSetting_reach (the Reach setting, a float), and the helpers band() and pal().
void main() {
  vec2 d = gl_FragCoord.xy - coverCenter();
  // The distance from the cover's centre in cover widths, and the angle folded to 0..1: the low bands to the
  // right, the high bands to the left, the halves above and below the middle mirrored.
  float r = length(d) / uCover.z;
  float m = abs(atan(d.y, d.x)) / PI;
  float reach = uSetting_reach * (0.55 + 0.7 * uLevel) * (1.0 + 0.18 * band(m));
  float glow = exp(-pow(r / reach, 2.0));
  vec3 tint = mix(uSetting_tint, pal(1.0 - glow), 0.3);
  outColor = vec4(tint * glow * (0.25 + 0.75 * uLevel), 1.0);
}
