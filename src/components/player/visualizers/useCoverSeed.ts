// -- Framework Imports --
import { useEffect, useState, useSyncExternalStore } from "react";

// -- Utils Imports --
import { isDarkTheme, subscribeTheme } from "../../../theme";

// -- Local Imports --
import { seedLayout } from "./coverSeed";
import { paintSeed } from "./paintSeed";
import type { CoverPixels, CoverPixelState } from "./useCoverPixels";

// The texture side, as for a real cover.
const SIDE = 512;

// Built seeds by (track, theme), least recently used last. Evicted bitmaps stay open: GL may hold them.
const CACHE_SIZE = 6;
const cache = new Map<string, ImageBitmap>();

function seedKey(trackId: number, dark: boolean): string {
  return `${trackId}:${dark ? "dark" : "light"}`;
}

async function buildSeed(trackId: number, dark: boolean): Promise<ImageBitmap> {
  const key = seedKey(trackId, dark);
  const hit = cache.get(key);
  if (hit) {
    cache.delete(key);
    cache.set(key, hit);
    return hit;
  }
  const canvas = await paintSeed(seedLayout(trackId), dark, SIDE);
  const bitmap = await createImageBitmap(canvas, { imageOrientation: "flipY" });
  cache.set(key, bitmap);
  if (cache.size > CACHE_SIZE) cache.delete(cache.keys().next().value as string);
  return bitmap;
}

/** The state of the seed at `key` given the key whose bitmap is held and the key whose build failed last. */
export function seedPixelState(
  key: string | null,
  loadedKey: string | null,
  failedKey: string | null,
): CoverPixelState {
  if (key == null) return "absent";
  if (loadedKey === key) return "ready";
  if (failedKey === key) return "absent";
  return "pending";
}

/**
 * The generated image of track `trackId` as a texture source; absent while it is null. A new track or
 * theme keeps the previous pixels until its own arrive, reported as pending. A failed build reports absent
 * and is retried the next time it is asked for.
 */
export function useCoverSeed(trackId: number | null): CoverPixels {
  const dark = useSyncExternalStore(subscribeTheme, isDarkTheme);
  const [loaded, setLoaded] = useState<{ key: string; bitmap: ImageBitmap } | null>(null);
  const [failedKey, setFailedKey] = useState<string | null>(null);
  const key = trackId == null ? null : seedKey(trackId, dark);

  useEffect(() => {
    if (trackId == null) return;
    const wanted = seedKey(trackId, dark);
    setFailedKey(null);
    let alive = true;
    buildSeed(trackId, dark)
      .then((bitmap) => {
        if (alive) setLoaded({ key: wanted, bitmap });
      })
      .catch(() => {
        if (!alive) return;
        setLoaded(null);
        setFailedKey(wanted);
      });
    return () => {
      alive = false;
    };
  }, [trackId, dark]);

  return { pixels: loaded?.bitmap ?? null, state: seedPixelState(key, loaded?.key ?? null, failedKey) };
}
