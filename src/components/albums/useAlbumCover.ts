// -- Framework Imports --
import { useCallback, useEffect, useRef, useState } from "react";

// -- Library Imports --
import { convertFileSrc } from "@tauri-apps/api/core";

// -- IPC Imports --
import { albumCover } from "../../lib/ipc";

// -- Type Imports --
import type { CoverSize } from "../../types";

/** An album's resolved cover: its cache path wrapped for the webview, a load flag, and a reload. */
export interface AlbumCoverView {
  src: string | null;
  loading: boolean;
  reload: () => void;
}

/** Wraps a cache path for the webview, degrading to the raw path outside the desktop shell. */
function toSrc(path: string): string {
  try {
    return convertFileSrc(path);
  } catch {
    return path;
  }
}

/**
 * Loads an album's cover at `size` on albumId change, wrapping its cache path for the webview. All IPC
 * lives here so the caller stays presentational; a failed or empty load leaves src null and the Cover
 * atom shows its placeholder. `reload` re-fetches after a cover set. A stale load from a fast change is
 * discarded.
 */
export function useAlbumCover(albumId: number, size: CoverSize = "thumb"): AlbumCoverView {
  const [src, setSrc] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const requestId = useRef(0);

  const load = useCallback(() => {
    const id = ++requestId.current;
    setLoading(true);
    void albumCover(albumId, size)
      .then((ref) => {
        // Drop the result if a newer load started while this one was in flight.
        if (id !== requestId.current) return;
        setSrc(ref ? toSrc(ref.path) : null);
      })
      .catch(() => {
        if (id !== requestId.current) return;
        setSrc(null);
      })
      .finally(() => {
        if (id === requestId.current) setLoading(false);
      });
  }, [albumId, size]);

  useEffect(() => {
    load();
  }, [load]);

  return { src, loading, reload: load };
}
