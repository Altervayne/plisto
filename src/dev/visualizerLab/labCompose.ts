/*
 * The picture a viewer sees: the layout's ground with the kind's GL canvas laid over it in the blend the
 * app gives that kind. The measures read this, not the raw framebuffer, so a kind that does not fill the
 * stage is measured against its ground and a screen or multiply layer is measured as it blends.
 */

// -- Type Imports --
import type { GlBlendMode } from "../../state/player/visualizerRegistry";

/** The 2D composite operation that stands for each CSS blend the app puts on the canvas. */
export const COMPOSITE_OP: Record<GlBlendMode, GlobalCompositeOperation> = {
  screen: "screen",
  multiply: "multiply",
  normal: "source-over",
};

/** A CSS rgb() color for an sRGB triple in 0..1. */
export function rgbCss([r, g, b]: [number, number, number]): string {
  return `rgb(${Math.round(r * 255)},${Math.round(g * 255)},${Math.round(b * 255)})`;
}

/** Reverses the rows of a top-down RGBA image into `out`, the bottom-up order `gl.readPixels` returns. */
export function flipRows(src: Uint8ClampedArray | Uint8Array, out: Uint8Array, width: number, height: number): void {
  const row = width * 4;
  for (let y = 0; y < height; y++) out.set(src.subarray(y * row, (y + 1) * row), (height - 1 - y) * row);
}

/**
 * A reader of the composited picture for one stage size, ground and blend. Each call draws the canvas over
 * the ground and returns the bytes in the order `readPixels` uses, so a result over an opaque normal-blend
 * kind is the framebuffer itself. The returned array is reused by the next call.
 */
export function createComposer(
  width: number,
  height: number,
  ground: [number, number, number],
  blend: GlBlendMode,
): (source: HTMLCanvasElement) => Uint8Array {
  const stage = document.createElement("canvas");
  stage.width = width;
  stage.height = height;
  const x = stage.getContext("2d", { willReadFrequently: true });
  if (!x) throw new Error("2d context unavailable");
  const fill = rgbCss(ground);
  const out = new Uint8Array(width * height * 4);
  return (source) => {
    x.globalCompositeOperation = "source-over";
    x.fillStyle = fill;
    x.fillRect(0, 0, width, height);
    x.globalCompositeOperation = COMPOSITE_OP[blend];
    x.drawImage(source, 0, 0);
    flipRows(x.getImageData(0, 0, width, height).data, out, width, height);
    return out;
  };
}
