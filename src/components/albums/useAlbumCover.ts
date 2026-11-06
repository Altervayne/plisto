// -- Framework Imports --
import { useCallback, useEffect, useState, useSyncExternalStore } from "react";

// -- Utils Imports --
import {
  albumCoverVersion,
  invalidateAlbumCover,
  peekAlbumCover,
  requestAlbumCover,
  subscribeAlbumCover,
} from "./albumCoverBatch";

// -- Type Imports --
import type { CoverSize } from "../../types";

export { invalidateAlbumCover };

/** An album's resolved cover: its cache path wrapped for the webview, a load flag, and a reload. */
export interface AlbumCoverView {
  src: string | null;
  loading: boolean;
  reload: () => void;
}

/**
 * Loads an album's cover at `size` on albumId change. All IPC lives in the batch loader, which folds
 * every card's request in a frame into one call, so the caller stays presentational; a failed or empty
 * load leaves src null and the Cover atom shows its placeholder. A shared cache hydrates a known cover
 * synchronously on mount, so a re-navigation renders it on the first paint with no fetch and no fade.
 * An invalidation of this album, from `reload` or any other surface, refetches in place. A stale load
 * from a fast change is discarded.
 */
export function useAlbumCover(albumId: number, size: CoverSize = "thumb"): AlbumCoverView {
  const version = useSyncExternalStore(subscribeAlbumCover, () => albumCoverVersion(albumId));
  const [src, setSrc] = useState<string | null>(() => peekAlbumCover(albumId, size) ?? null);
  const [loading, setLoading] = useState(false);

  // A cache hit paints from memory - synchronously on mount via the initial state, or here when the key
  // changes on a kept hook (the drawer swapping albums) - and skips the fetch. A miss joins the batch.
  useEffect(() => {
    const cached = peekAlbumCover(albumId, size);
    if (cached !== undefined) {
      setSrc(cached);
      setLoading(false);
      return;
    }
    let live = true;
    setLoading(true);
    void requestAlbumCover(albumId, size).then((resolved) => {
      if (!live) return;
      setSrc(resolved);
      setLoading(false);
    });
    return () => {
      live = false;
    };
  }, [albumId, size, version]);

  // Invalidate, so setAlbumCover / removeAlbumCover surface the new art or the placeholder on every
  // card showing this album.
  const reload = useCallback(() => invalidateAlbumCover(albumId), [albumId]);

  return { src, loading, reload };
}
