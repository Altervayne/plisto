// -- Framework Imports --
import { useCallback, useEffect, useRef, useState } from "react";

// -- Library Imports --
import { convertFileSrc } from "@tauri-apps/api/core";

// -- IPC Imports --
import { playlistCover } from "../../lib/ipc";

// -- Type Imports --
import type { CoverSize } from "../../types";

/** A playlist's bound cover: its cache path wrapped for the webview, a load flag, and a reload. */
export interface PlaylistCoverView {
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
 * Loads a playlist's bound cover at `size` on playlistId change, wrapping its cache path for the webview.
 * All IPC lives here so the caller stays presentational; an unset or failed load leaves src null and the
 * Cover atom shows its placeholder. Unlike the album hook there is no track fallback - a playlist cover is
 * only ever the imported one. `reload` re-fetches after a set or a remove. A stale load from a fast change
 * is discarded.
 */
export function usePlaylistCover(playlistId: number, size: CoverSize = "thumb"): PlaylistCoverView {
  const [src, setSrc] = useState<string | null>(null);
  const [loading, setLoading] = useState(false);
  const requestId = useRef(0);

  const load = useCallback(() => {
    const id = ++requestId.current;
    setLoading(true);
    void playlistCover(playlistId, size)
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
  }, [playlistId, size]);

  useEffect(() => {
    load();
  }, [load]);

  return { src, loading, reload: load };
}
