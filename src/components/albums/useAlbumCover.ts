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

// The resolved src per album and size, kept across mounts so returning to the grid paints from memory
// with no IPC. Set on a successful resolve, dropped on reload so a cover set or clear re-fetches.
const coverCache = new Map<string, string>();

/**
 * Drops an album's cached cover at both sizes, so a cover bound from another surface (the covers
 * workspace) re-fetches on the next mount rather than painting stale art. Mounted hooks pick it up when
 * they next remount; a caller wanting an in-place refresh remounts through a key.
 */
export function invalidateAlbumCover(albumId: number): void {
  coverCache.delete(`${albumId}:thumb`);
  coverCache.delete(`${albumId}:detail`);
}

/**
 * Loads an album's cover at `size` on albumId change, wrapping its cache path for the webview. All IPC
 * lives here so the caller stays presentational; a failed or empty load leaves src null and the Cover
 * atom shows its placeholder. A shared cache hydrates a known cover synchronously on mount, so a
 * re-navigation renders it on the first paint with no fetch and no fade. `reload` invalidates that
 * entry and re-fetches after a cover set. A stale load from a fast change is discarded.
 */
export function useAlbumCover(albumId: number, size: CoverSize = "thumb"): AlbumCoverView {
  const key = `${albumId}:${size}`;
  const [src, setSrc] = useState<string | null>(() => coverCache.get(key) ?? null);
  const [loading, setLoading] = useState(false);
  const requestId = useRef(0);

  const load = useCallback(() => {
    const id = ++requestId.current;
    setLoading(true);
    void albumCover(albumId, size)
      .then((ref) => {
        // Drop the result if a newer load started while this one was in flight.
        if (id !== requestId.current) return;
        const resolved = ref ? toSrc(ref.path) : null;
        if (resolved) coverCache.set(key, resolved);
        setSrc(resolved);
      })
      .catch(() => {
        if (id !== requestId.current) return;
        setSrc(null);
      })
      .finally(() => {
        if (id === requestId.current) setLoading(false);
      });
  }, [albumId, size, key]);

  // A cache hit paints from memory - synchronously on mount via the initial state, or here when the key
  // changes on a kept hook (the drawer swapping albums) - and skips the fetch. A miss fetches.
  useEffect(() => {
    const cached = coverCache.get(key);
    if (cached !== undefined) {
      setSrc(cached);
      return;
    }
    load();
  }, [key, load]);

  // Invalidate then re-fetch, so setAlbumCover / removeAlbumCover surface the new art or the placeholder.
  const reload = useCallback(() => {
    coverCache.delete(key);
    load();
  }, [key, load]);

  return { src, loading, reload };
}
