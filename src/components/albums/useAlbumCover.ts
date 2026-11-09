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

/** The first-render state: a cached cover paints at once, a miss starts loading so no frame claims "no cover". */
export function initialAlbumCover(albumId: number, size: CoverSize): Pick<AlbumCoverView, "src" | "loading"> {
  const cached = peekAlbumCover(albumId, size);
  return { src: cached ?? null, loading: cached === undefined };
}

/**
 * Loads an album's cover at `size` on albumId change. All IPC lives in the batch loader, which folds
 * every card's request in a frame into one call, so the caller stays presentational; a failed or empty
 * load leaves src null and loading false. `loading` is true from the first render until the batch answers. A shared cache hydrates a known cover
 * synchronously on mount, so a re-navigation renders it on the first paint with no fetch and no fade.
 * An invalidation of this album, from `reload` or any other surface, refetches in place. A stale load
 * from a fast change is discarded.
 */
export function useAlbumCover(albumId: number, size: CoverSize = "thumb"): AlbumCoverView {
  const version = useSyncExternalStore(subscribeAlbumCover, () => albumCoverVersion(albumId));
  const [src, setSrc] = useState<string | null>(() => initialAlbumCover(albumId, size).src);
  const [loading, setLoading] = useState(() => initialAlbumCover(albumId, size).loading);
  // The album and size the state above belongs to. A kept hook renders once with the old album's state
  // before its effect runs; that render reads the first-render state instead.
  const key = `${albumId}:${size}`;
  const [stateKey, setStateKey] = useState(key);

  // A cache hit paints from memory - synchronously on mount via the initial state, or here when the key
  // changes on a kept hook (the drawer swapping albums) - and skips the fetch. A miss joins the batch.
  useEffect(() => {
    setStateKey(`${albumId}:${size}`);
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

  if (stateKey !== key) return { ...initialAlbumCover(albumId, size), reload };
  return { src, loading, reload };
}
