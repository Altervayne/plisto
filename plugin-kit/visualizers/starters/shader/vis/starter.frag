// Plisto puts its prelude before this file: uRes, uTime, uBands[24], uLevel, uPal[3], uCover, the
// helpers band(), pal() and coverCenter(), and the output `outColor`. Write main().
// A glow draws light: black is nothing, and Plisto maps the light onto the stage for the theme.
void main() {
  // The distance from the cover's centre, in cover widths.
  float r = length(gl_FragCoord.xy - coverCenter()) / uCover.z;
  // The disc grows and brightens with the eased level, which moves too slowly to flash.
  float glow = exp(-pow(r / (0.5 + 0.8 * uLevel), 2.0));
  outColor = vec4(pal(glow) * glow * (0.3 + 0.7 * uLevel), 1.0);
}
