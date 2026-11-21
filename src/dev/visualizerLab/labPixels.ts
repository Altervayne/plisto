/*
 * Pixel helpers the lab's modes share: reading a canvas back, hashing it, and Rec. 709 luma on the sRGB
 * bytes for the brightness steps. The flash meter lives in the flash module.
 */

/** The bytes of the canvas' default framebuffer, read straight after a draw. */
export function readPixels(canvas: HTMLCanvasElement): Uint8Array {
  const gl = canvas.getContext("webgl2") as WebGL2RenderingContext;
  const out = new Uint8Array(canvas.width * canvas.height * 4);
  gl.readPixels(0, 0, canvas.width, canvas.height, gl.RGBA, gl.UNSIGNED_BYTE, out);
  return out;
}

export async function sha256(bytes: Uint8Array): Promise<string> {
  const digest = await crypto.subtle.digest("SHA-256", bytes);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, "0")).join("");
}

/** Rounds to three decimals, for a result that reads at a glance. */
export function round(v: number): number {
  return Math.round(v * 1000) / 1000;
}

/** The mean Rec. 709 luma of the stage in 0..1 over the sRGB bytes, sampling every fourth pixel. */
export function meanLuma709(bytes: Uint8Array): number {
  let sum = 0;
  for (let j = 0; j < bytes.length; j += 16) sum += 0.2126 * bytes[j] + 0.7152 * bytes[j + 1] + 0.0722 * bytes[j + 2];
  return sum / (bytes.length / 16) / 255;
}
