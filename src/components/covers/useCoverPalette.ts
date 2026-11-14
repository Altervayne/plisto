// -- Framework Imports --
import { useEffect, useRef, useState } from "react";

// -- IPC Imports --
import { getCoverPalette } from "../../lib/ipc";

/** A track's dominant cover colours as sRGB triples, or null for no cover / a near-gray cover. */
export type Palette = [number, number, number][];

// The resolved palette per track, kept across mounts so a return to the player paints from memory.
// Invalidated alongside the thumb when a track takes a new cover, so the next read reflects it.
// Each entry remembers the artwork revision it was read at, so a newer revision re-derives it.
const paletteCache = new Map<number, { rev: number; palette: Palette | null }>();

/** The cached palette for a track at a revision: undefined when absent or read at another revision. */
export function cachedPalette(trackId: number, rev: number): Palette | null | undefined {
  const entry = paletteCache.get(trackId);
  return entry && entry.rev === rev ? entry.palette : undefined;
}

/** Remembers a track's palette at a revision, replacing an entry read at another one. */
export function rememberPalette(trackId: number, rev: number, palette: Palette | null): void {
  paletteCache.set(trackId, { rev, palette });
}

/** Drops a track's cached palette, so the next read re-derives it after a cover assign. */
export function invalidateTrackPalette(trackId: number): void {
  paletteCache.delete(trackId);
}

/**
 * Loads a track's dominant cover palette, mirroring the cached-cover hook: IPC-only, a shared cache
 * hydrates a known result synchronously on mount, and a stale load from a fast track switch is
 * discarded. Null while the first load is in flight, and null for a track whose cover is missing or
 * near-gray - the aurora reads that as its neutral tint. `rev` re-derives the palette when the art
 * changes under the same id, as a plugin stream's artwork does mid-item.
 */
export function useCoverPalette(trackId: number, rev = 0): Palette | null {
  const [palette, setPalette] = useState<Palette | null>(() => cachedPalette(trackId, rev) ?? null);
  const requestId = useRef(0);

  useEffect(() => {
    const cached = cachedPalette(trackId, rev);
    if (cached !== undefined) {
      setPalette(cached);
      return;
    }
    const id = ++requestId.current;
    void getCoverPalette(trackId)
      .then((colors) => {
        if (id !== requestId.current) return;
        rememberPalette(trackId, rev, colors);
        setPalette(colors);
      })
      .catch(() => {
        if (id !== requestId.current) return;
        setPalette(null);
      });
  }, [trackId, rev]);

  return palette;
}
