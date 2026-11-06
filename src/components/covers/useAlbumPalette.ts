// -- Framework Imports --
import { useEffect, useRef, useState, useSyncExternalStore } from "react";

// -- Hook Imports --
import { albumCoverVersion, subscribeAlbumCover } from "../albums/albumCoverBatch";

// -- IPC Imports --
import { albumCoverPalette } from "../../lib/ipc";

// -- Type Imports --
import type { Palette } from "./useCoverPalette";

// The resolved palette per album and cover version, kept across mounts so a return to Browse paints
// from memory. A cover change bumps the album's version, so the next read re-derives.
const paletteCache = new Map<string, Palette | null>();

const keyOf = (albumId: number, version: number) => `${albumId}:${version}`;

/**
 * Loads an album's dominant cover palette, mirroring useCoverPalette but keyed by album, so a bound
 * cover glows instead of its first track's art. Null while the first load is in flight, and null for
 * an album with no cover or a near-gray one - the glow reads that as its neutral tint. Pass null to
 * read nothing (no album in focus). A cover set or cleared re-derives it.
 */
export function useAlbumPalette(albumId: number | null): Palette | null {
  const version = useSyncExternalStore(subscribeAlbumCover, () =>
    albumId === null ? 0 : albumCoverVersion(albumId),
  );
  const [palette, setPalette] = useState<Palette | null>(() =>
    albumId === null ? null : (paletteCache.get(keyOf(albumId, version)) ?? null),
  );
  const requestId = useRef(0);

  useEffect(() => {
    const id = ++requestId.current;
    if (albumId === null) {
      setPalette(null);
      return;
    }
    const key = keyOf(albumId, version);
    const cached = paletteCache.get(key);
    if (cached !== undefined) {
      setPalette(cached);
      return;
    }
    void albumCoverPalette(albumId)
      .then((colors) => {
        if (id !== requestId.current) return;
        paletteCache.set(key, colors);
        setPalette(colors);
      })
      .catch(() => {
        if (id !== requestId.current) return;
        setPalette(null);
      });
  }, [albumId, version]);

  return palette;
}
