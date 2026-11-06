/*
 * The album cover loader behind useAlbumCover: coalesces every request made in one frame into a single
 * batched IPC per size, owns the resolved-src cache, and keeps a per-album version that invalidation
 * bumps so mounted hooks refetch in place. A response that lands after its album was invalidated is
 * handed back but never cached, so a stale cover cannot outlive a cover set.
 */

// -- Library Imports --
import { convertFileSrc } from "@tauri-apps/api/core";

// -- IPC Imports --
import { albumCovers } from "../../lib/ipc";

// -- Type Imports --
import type { CoverSize } from "../../types";

const SIZES: CoverSize[] = ["thumb", "grid", "detail"];

type Resolve = (src: string | null) => void;

// The resolved src per album and size, kept across mounts so returning to the grid paints from memory
// with no IPC. Only a successful resolve is stored.
const srcCache = new Map<string, string>();
// Requests asked for but not yet sent, then sent but not yet answered, so a repeat ask shares one fetch.
const queued = new Map<string, Resolve>();
const inFlight = new Map<string, Promise<string | null>>();
const versions = new Map<number, number>();
const listeners = new Set<() => void>();
let flushScheduled = false;

const keyOf = (albumId: number, size: CoverSize) => `${albumId}:${size}`;

/** Wraps a cache path for the webview, degrading to the raw path outside the desktop shell. */
function toSrc(path: string): string {
  try {
    return convertFileSrc(path);
  } catch {
    return path;
  }
}

/** The cached src for an album at a size, or undefined when it has not resolved yet. */
export function peekAlbumCover(albumId: number, size: CoverSize): string | undefined {
  return srcCache.get(keyOf(albumId, size));
}

/** The album's invalidation count; a change tells a mounted hook to refetch. */
export function albumCoverVersion(albumId: number): number {
  return versions.get(albumId) ?? 0;
}

/** Subscribes to invalidations; returns the unsubscribe. */
export function subscribeAlbumCover(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

/**
 * Drops an album's cached cover at every size and bumps its version, so mounted cards refetch in
 * place and a cover bound from another surface never paints stale art. Requests still in flight for
 * the album are forgotten: their answers are not cached.
 */
export function invalidateAlbumCover(albumId: number): void {
  for (const size of SIZES) {
    const key = keyOf(albumId, size);
    srcCache.delete(key);
    // A request not sent yet stays shared: it reads fresh data when the frame flushes.
    if (!queued.has(key)) inFlight.delete(key);
  }
  versions.set(albumId, albumCoverVersion(albumId) + 1);
  listeners.forEach((listener) => listener());
}

/**
 * Resolves an album's cover src at `size`. A cached cover answers at once; otherwise the request joins
 * the frame's batch. Resolves null for no cover or a failed read.
 */
export function requestAlbumCover(albumId: number, size: CoverSize): Promise<string | null> {
  const key = keyOf(albumId, size);
  const cached = srcCache.get(key);
  if (cached !== undefined) return Promise.resolve(cached);
  const pending = inFlight.get(key);
  if (pending) return pending;

  const promise = new Promise<string | null>((resolve) => {
    queued.set(key, resolve);
  });
  inFlight.set(key, promise);
  scheduleFlush();
  return promise;
}

/** Waits for the end of the frame so every request made during it rides one call. */
function scheduleFlush(): void {
  if (flushScheduled) return;
  flushScheduled = true;
  const run = () => {
    flushScheduled = false;
    flush();
  };
  if (typeof requestAnimationFrame === "function") requestAnimationFrame(run);
  else setTimeout(run, 0);
}

/** A request on the wire: the album version it was sent at, and who is waiting on it. */
interface Sent {
  version: number;
  resolve: Resolve;
}

/** Sends one albumCovers call per size for everything queued, then settles each waiter. */
function flush(): void {
  const batch = new Map<CoverSize, number[]>();
  const sent = new Map<string, Sent>();
  for (const [key, resolve] of queued) {
    const [id, size] = key.split(":");
    const albumId = Number(id);
    const ids = batch.get(size as CoverSize) ?? [];
    ids.push(albumId);
    batch.set(size as CoverSize, ids);
    sent.set(key, { version: albumCoverVersion(albumId), resolve });
  }
  queued.clear();

  for (const [size, ids] of batch) {
    albumCovers(ids, size)
      .then((entries) => {
        ids.forEach((albumId, index) => {
          const entry = entries[index];
          const src = entry?.cover ? toSrc(entry.cover.path) : null;
          settle(albumId, size, sent, src);
        });
      })
      .catch(() => ids.forEach((albumId) => settle(albumId, size, sent, null)));
  }
}

/** Caches a fresh answer and releases the waiter; a stale answer is released uncached. */
function settle(
  albumId: number,
  size: CoverSize,
  sent: Map<string, Sent>,
  src: string | null,
): void {
  const key = keyOf(albumId, size);
  const record = sent.get(key);
  if (!record) return;
  const fresh = record.version === albumCoverVersion(albumId);
  if (fresh) {
    if (src !== null) srcCache.set(key, src);
    inFlight.delete(key);
  }
  record.resolve(src);
}

/** Clears every cache and queue; tests only. */
export function resetAlbumCoverBatch(): void {
  srcCache.clear();
  queued.clear();
  inFlight.clear();
  versions.clear();
  listeners.clear();
  flushScheduled = false;
}
