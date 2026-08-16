// -- Framework Imports --
import { useEffect, useRef, useState } from "react";

// -- Library Imports --
import { convertFileSrc } from "@tauri-apps/api/core";

// -- IPC Imports --
import { readCover } from "../../lib/ipc";

/** Wraps a cache path for the webview, degrading to the raw path outside the desktop shell. */
function toSrc(path: string): string {
  try {
    return convertFileSrc(path);
  } catch {
    return path;
  }
}

// The resolved thumbnail per track, kept across mounts so the checklist and the cover-state tile paint
// from memory. Invalidated when a track takes a new cover, so the next read shows the fresh art.
const trackThumbCache = new Map<number, string | null>();

/** Drops a track's cached thumbnail so the next read re-resolves it after a cover assign. */
export function invalidateTrackThumb(trackId: number): void {
  trackThumbCache.delete(trackId);
}

/**
 * Loads a track's resolved cover thumbnail, mirroring the album cover hook: IPC-only, a shared cache
 * hydrates a known thumb synchronously on mount, and a stale load from a fast change is discarded. Reads
 * the default resolution (embedded, adjacent, then folder cover), so a track with no art shows the recess.
 */
export function useTrackThumb(trackId: number): string | null {
  const [src, setSrc] = useState<string | null>(() => trackThumbCache.get(trackId) ?? null);
  const requestId = useRef(0);

  useEffect(() => {
    const cached = trackThumbCache.get(trackId);
    if (cached !== undefined) {
      setSrc(cached);
      return;
    }
    const id = ++requestId.current;
    void readCover(trackId, "thumb")
      .then((ref) => {
        if (id !== requestId.current) return;
        const resolved = ref ? toSrc(ref.path) : null;
        trackThumbCache.set(trackId, resolved);
        setSrc(resolved);
      })
      .catch(() => {
        if (id !== requestId.current) return;
        setSrc(null);
      });
  }, [trackId]);

  return src;
}
