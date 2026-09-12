// -- Framework Imports --
import { useEffect, useRef, useState } from "react";

// -- Library Imports --
import { convertFileSrc } from "@tauri-apps/api/core";

// -- IPC Imports --
import { readCover } from "../../lib/ipc";

// -- Type Imports --
import type { CoverSize } from "../../types";

/** Wraps a cache path for the webview, degrading to the raw path outside the desktop shell. */
function toSrc(path: string): string {
  try {
    return convertFileSrc(path);
  } catch {
    return path;
  }
}

/** Cache key that keeps a track's thumb and detail resolutions apart. */
function cacheKey(size: CoverSize, trackId: number): string {
  return `${size}:${trackId}`;
}

// The resolved cover per track and size, kept across mounts so the checklist and the cover-state tile paint
// from memory. Invalidated when a track takes a new cover, so the next read shows the fresh art.
const coverCache = new Map<string, string | null>();

/** Drops a track's cached covers, both sizes, so the next read re-resolves them after a cover assign. */
export function invalidateTrackThumb(trackId: number): void {
  coverCache.delete(cacheKey("thumb", trackId));
  coverCache.delete(cacheKey("detail", trackId));
}

/**
 * Loads a track's resolved cover at one size, mirroring the album cover hook: IPC-only, a shared cache
 * hydrates a known resolution synchronously on mount, and a stale load from a fast change is discarded. Reads
 * the default source order (embedded, adjacent, then folder cover), so a track with no art shows the recess.
 */
export function useCachedCover(trackId: number, size: CoverSize): string | null {
  const [src, setSrc] = useState<string | null>(() => coverCache.get(cacheKey(size, trackId)) ?? null);
  const requestId = useRef(0);

  useEffect(() => {
    const key = cacheKey(size, trackId);
    const cached = coverCache.get(key);
    if (cached !== undefined) {
      setSrc(cached);
      return;
    }
    const id = ++requestId.current;
    void readCover(trackId, size)
      .then((ref) => {
        if (id !== requestId.current) return;
        const resolved = ref ? toSrc(ref.path) : null;
        coverCache.set(key, resolved);
        setSrc(resolved);
      })
      .catch(() => {
        if (id !== requestId.current) return;
        setSrc(null);
      });
  }, [trackId, size]);

  return src;
}

/** A track's 128px thumbnail, for the dense checklist, grids, and cover-state tiles. */
export function useTrackThumb(trackId: number): string | null {
  return useCachedCover(trackId, "thumb");
}

/** A track's 512px cover, for surfaces that show the art large enough to expose thumb upscaling. */
export function useTrackDetail(trackId: number): string | null {
  return useCachedCover(trackId, "detail");
}
