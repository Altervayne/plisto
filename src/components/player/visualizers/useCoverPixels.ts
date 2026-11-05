// -- Framework Imports --
import { useEffect, useState } from "react";

// The texture side. The liquid surface samples a cover-sized patch, so more detail never shows.
const SIDE = 512;

/**
 * Reads a cover into GL-ready pixels: a centre square, downscaled and flipped for GL's bottom-up rows.
 * The asset protocol answers with the window's origin as its CORS origin, so a fetch of the cover URL
 * yields readable bytes, and a bitmap decoded from that blob never taints a WebGL texture the way the
 * cover's own img element would.
 */
async function loadCoverPixels(src: string): Promise<ImageBitmap> {
  const res = await fetch(src);
  if (!res.ok) throw new Error(`cover fetch failed: ${res.status}`);
  const full = await createImageBitmap(await res.blob());
  const side = Math.min(full.width, full.height);
  try {
    return await createImageBitmap(full, (full.width - side) / 2, (full.height - side) / 2, side, side, {
      resizeWidth: SIDE,
      resizeHeight: SIDE,
      resizeQuality: "high",
      imageOrientation: "flipY",
    });
  } finally {
    full.close();
  }
}

/**
 * The cover at `src` as a texture source, or null without a src or when it cannot be read. A new src
 * keeps the previous pixels until its own arrive, so a track change never drops the surface to its
 * fallback for a frame.
 */
export function useCoverPixels(src: string | null): ImageBitmap | null {
  const [pixels, setPixels] = useState<ImageBitmap | null>(null);

  useEffect(() => {
    if (src == null) {
      setPixels(null);
      return;
    }
    let alive = true;
    loadCoverPixels(src)
      .then((bitmap) => {
        if (alive) setPixels(bitmap);
      })
      .catch(() => {
        if (alive) setPixels(null);
      });
    return () => {
      alive = false;
    };
  }, [src]);

  return pixels;
}
