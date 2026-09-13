// -- Framework Imports --
import { useEffect, useRef, useState } from "react";

// -- IPC Imports --
import { getCoverPalette } from "../../lib/ipc";

/** A track's dominant cover colours as sRGB triples, or null for no cover / a near-gray cover. */
export type Palette = [number, number, number][];

// The resolved palette per track, kept across mounts so a return to the player paints from memory.
// Invalidated alongside the thumb when a track takes a new cover, so the next read reflects it.
const paletteCache = new Map<number, Palette | null>();

/** Drops a track's cached palette, so the next read re-derives it after a cover assign. */
export function invalidateTrackPalette(trackId: number): void {
  paletteCache.delete(trackId);
}

/**
 * Loads a track's dominant cover palette, mirroring the cached-cover hook: IPC-only, a shared cache
 * hydrates a known result synchronously on mount, and a stale load from a fast track switch is
 * discarded. Null while the first load is in flight, and null for a track whose cover is missing or
 * near-gray - the aurora reads that as its neutral tint.
 */
export function useCoverPalette(trackId: number): Palette | null {
  const [palette, setPalette] = useState<Palette | null>(() => paletteCache.get(trackId) ?? null);
  const requestId = useRef(0);

  useEffect(() => {
    const cached = paletteCache.get(trackId);
    if (cached !== undefined) {
      setPalette(cached);
      return;
    }
    const id = ++requestId.current;
    void getCoverPalette(trackId)
      .then((colors) => {
        if (id !== requestId.current) return;
        paletteCache.set(trackId, colors);
        setPalette(colors);
      })
      .catch(() => {
        if (id !== requestId.current) return;
        setPalette(null);
      });
  }, [trackId]);

  return palette;
}
