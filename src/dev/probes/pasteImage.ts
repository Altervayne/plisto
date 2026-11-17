/*
 * Reads an image from a paste into memory as RGBA, without color conversion. Nothing is written anywhere.
 */

// -- Type Imports --
import type { Rgba } from "./pixelDiff";

/** The type of every item on a clipboard, in order. */
export function itemTypes(data: DataTransfer | null): string[] {
  return data ? Array.from(data.items, (item) => item.type) : [];
}

/** The file behind the clipboard item at `index`. Only valid while the paste event is being handled. */
export function itemFile(data: DataTransfer, index: number): File | null {
  return data.items[index]?.getAsFile() ?? null;
}

/** Decodes an image file to pixels. */
export async function readPastedImage(file: Blob): Promise<Rgba> {
  const bitmap = await createImageBitmap(file, { colorSpaceConversion: "none" });
  try {
    const canvas = document.createElement("canvas");
    canvas.width = bitmap.width;
    canvas.height = bitmap.height;
    const ctx = canvas.getContext("2d", { willReadFrequently: true });
    if (!ctx) throw new Error("no 2d context to decode the pasted image");
    ctx.drawImage(bitmap, 0, 0);
    const pixels = ctx.getImageData(0, 0, bitmap.width, bitmap.height);
    return { width: pixels.width, height: pixels.height, data: pixels.data };
  } finally {
    bitmap.close();
  }
}
