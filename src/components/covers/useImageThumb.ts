// -- Framework Imports --
import { useCallback, useEffect, useRef, useState } from "react";

// -- Library Imports --
import { convertFileSrc } from "@tauri-apps/api/core";

// -- IPC Imports --
import { imageThumb } from "../../lib/ipc";

/** One loose image's thumbnail: its wrapped cache path, or a failed flag when it cannot be read. */
export interface ImageThumbView {
  src: string | null;
  failed: boolean;
  onError: () => void;
}

/** Wraps a cache path for the webview, degrading to the raw path outside the desktop shell. */
function toSrc(path: string): string {
  try {
    return convertFileSrc(path);
  } catch {
    return path;
  }
}

// The resolved thumbnail per source path, kept across mounts so a returning row paints from memory with
// no second decode. Set on a successful resolve; a path never changes its bytes, so nothing invalidates it.
const thumbCache = new Map<string, string>();

/**
 * Loads a per-tile thumbnail for an arbitrary on-disk image, mirroring the album cover hook: all IPC
 * lives here, a shared cache hydrates a known thumb synchronously on mount, and a stale load from a fast
 * change is discarded. A null return (unreadable, deleted after the scan) or an image load error sets
 * `failed`, which the tile reads to show its unavailable placeholder and refuse the bind.
 */
export function useImageThumb(path: string): ImageThumbView {
  const [src, setSrc] = useState<string | null>(() => thumbCache.get(path) ?? null);
  const [failed, setFailed] = useState(false);
  const requestId = useRef(0);

  useEffect(() => {
    const cached = thumbCache.get(path);
    if (cached !== undefined) {
      setSrc(cached);
      setFailed(false);
      return;
    }
    const id = ++requestId.current;
    setFailed(false);
    void imageThumb(path, "thumb")
      .then((ref) => {
        if (id !== requestId.current) return;
        if (!ref) {
          setFailed(true);
          setSrc(null);
          return;
        }
        const resolved = toSrc(ref.path);
        thumbCache.set(path, resolved);
        setSrc(resolved);
      })
      .catch(() => {
        if (id !== requestId.current) return;
        setFailed(true);
        setSrc(null);
      });
  }, [path]);

  const onError = useCallback(() => setFailed(true), []);

  return { src, failed, onError };
}
