// -- Framework Imports --
import { useEffect, useRef, useState } from "react";

// -- Library Imports --
import { convertFileSrc } from "@tauri-apps/api/core";

// -- IPC Imports --
import { albumCover } from "../../lib/ipc";

/** An album's resolved cover for the card: its cache path wrapped for the webview, and a load flag. */
export interface AlbumCoverView {
  src: string | null;
  loading: boolean;
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
 * Loads an album's thumbnail on albumId change, wrapping its cache path for the webview. All IPC
 * lives here so the card stays presentational; a failed or empty load leaves src null and the Cover
 * atom shows its placeholder. A stale load from a fast change is discarded.
 */
export function useAlbumCover(albumId: number): AlbumCoverView {
  const [src, setSrc] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const requestId = useRef(0);

  useEffect(() => {
    const id = ++requestId.current;
    setLoading(true);
    void albumCover(albumId, "thumb")
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
  }, [albumId]);

  return { src, loading };
}
