/*
 * Facts about the machine and webview the header and the report state: the display refresh rate and the
 * WebGL renderer string. Each reading is best-effort and falls back to a plain "unknown".
 */

// -- Local Imports --
import { median } from "./stats";

/** The display rate in Hz from the median rAF interval over `ms`; null when no frames arrived. */
export function measureDisplayHz(ms = 2000): Promise<number | null> {
  return new Promise((resolve) => {
    const intervals: number[] = [];
    let last = 0;
    const end = performance.now() + ms;
    const tick = (now: number) => {
      if (last) intervals.push(now - last);
      last = now;
      if (now < end) requestAnimationFrame(tick);
      else resolve(intervals.length ? 1000 / median(intervals) : null);
    };
    requestAnimationFrame(tick);
  });
}

/** The unmasked WebGL renderer string of the main document, or "unavailable". */
export function glRendererString(): string {
  const gl = document.createElement("canvas").getContext("webgl2");
  if (!gl) return "unavailable";
  const info = gl.getExtension("WEBGL_debug_renderer_info");
  const value = info ? gl.getParameter(info.UNMASKED_RENDERER_WEBGL) : gl.getParameter(gl.RENDERER);
  gl.getExtension("WEBGL_lose_context")?.loseContext();
  return typeof value === "string" ? value : "unavailable";
}
