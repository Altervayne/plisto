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

/** Whether the cover at `src` is on hand: absent without a src or after a failed read, pending until it lands. */
export type CoverPixelState = "absent" | "pending" | "ready";

export interface CoverPixels {
  pixels: ImageBitmap | null;
  state: CoverPixelState;
}

/** The state of `src` given the src whose bitmap is held and the src whose read failed last. */
export function coverPixelState(
  src: string | null,
  loadedSrc: string | null,
  failedSrc: string | null,
): CoverPixelState {
  if (src == null) return "absent";
  if (loadedSrc === src) return "ready";
  if (failedSrc === src) return "absent";
  return "pending";
}

/**
 * The cover at `src` as a texture source. A new src keeps the previous pixels until its own arrive, so a
 * track change never drops the surface to its fallback for a frame, but reports them as pending. A failed
 * read drops the pixels and reports absent.
 */
export function useCoverPixels(src: string | null): CoverPixels {
  const [loaded, setLoaded] = useState<{ src: string; bitmap: ImageBitmap } | null>(null);
  const [failedSrc, setFailedSrc] = useState<string | null>(null);

  useEffect(() => {
    if (src == null) {
      setLoaded(null);
      return;
    }
    // A src that failed before reads as pending again while it is retried.
    setFailedSrc(null);
    let alive = true;
    loadCoverPixels(src)
      .then((bitmap) => {
        if (alive) setLoaded({ src, bitmap });
      })
      .catch(() => {
        if (!alive) return;
        setLoaded(null);
        setFailedSrc(src);
      });
    return () => {
      alive = false;
    };
  }, [src]);

  return {
    pixels: loaded?.bitmap ?? null,
    state: coverPixelState(src, loaded?.src ?? null, failedSrc),
  };
}
