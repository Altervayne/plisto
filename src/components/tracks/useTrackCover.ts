// -- Framework Imports --
import { useCallback, useEffect, useRef, useState } from "react";

// -- Library Imports --
import { convertFileSrc } from "@tauri-apps/api/core";

// -- Local Imports --
import {
  importFolderCover,
  listCoverCandidates,
  readCover,
  removeFolderCover,
} from "../../lib/ipc";
import { pickImageFile } from "../../lib/dialog";

// -- Type Imports --
import type { CoverSource } from "../../types";

/** The resolved cover for a track, its cache path already wrapped for the webview. */
export interface CoverView {
  src: string;
  source: CoverSource;
  width: number;
  height: number;
}

/** One selectable art source, its thumbnail path wrapped and its on-disk origin kept for binding. */
export interface CandidateView {
  src: string;
  source: CoverSource;
  originPath: string | null;
  width: number;
  height: number;
}

/** What a track's cover surface reads and can do. Loading and errors are surfaced, not thrown. */
export interface TrackCover {
  cover: CoverView | null;
  candidates: CandidateView[];
  loading: boolean;
  error: string | null;
  importFromDisk: () => Promise<void>;
  useCandidate: (candidate: CandidateView) => Promise<void>;
  remove: () => Promise<void>;
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
 * Owns a track's cover: loads its resolved art and every candidate source on trackId change, and
 * exposes the import/use/remove actions, each reloading afterwards. All IPC lives here so the
 * cover surface stays presentational. A stale load from a fast track switch is discarded.
 */
export function useTrackCover(trackId: number): TrackCover {
  const [cover, setCover] = useState<CoverView | null>(null);
  const [candidates, setCandidates] = useState<CandidateView[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const requestId = useRef(0);

  const load = useCallback(async (): Promise<void> => {
    const id = ++requestId.current;
    setLoading(true);
    setError(null);
    try {
      const [ref, cands] = await Promise.all([
        readCover(trackId, "detail"),
        listCoverCandidates(trackId),
      ]);
      // Drop the result if a newer load started while this one was in flight.
      if (id !== requestId.current) return;
      setCover(
        ref
          ? { src: toSrc(ref.path), source: ref.source, width: ref.width, height: ref.height }
          : null,
      );
      setCandidates(
        cands.map((c) => ({
          src: toSrc(c.path),
          source: c.source,
          originPath: c.origin_path,
          width: c.width,
          height: c.height,
        })),
      );
    } catch {
      // A passive load failure stays quiet: the cover simply does not show. Only the explicit
      // import/use/remove actions surface a message.
      if (id !== requestId.current) return;
      setCover(null);
      setCandidates([]);
    } finally {
      if (id === requestId.current) setLoading(false);
    }
  }, [trackId]);

  useEffect(() => {
    void load();
  }, [load]);

  const importFromDisk = useCallback(async (): Promise<void> => {
    const path = await pickImageFile();
    if (!path) return;
    try {
      await importFolderCover(trackId, path);
    } catch (e) {
      setError(String(e));
      return;
    }
    await load();
  }, [trackId, load]);

  const useCandidate = useCallback(
    async (candidate: CandidateView): Promise<void> => {
      // Only an adjacent image is a real file on disk to bind; the embedded source is intrinsic.
      if (candidate.source !== "adjacent" || !candidate.originPath) return;
      try {
        await importFolderCover(trackId, candidate.originPath);
      } catch (e) {
        setError(String(e));
        return;
      }
      await load();
    },
    [trackId, load],
  );

  const remove = useCallback(async (): Promise<void> => {
    try {
      await removeFolderCover(trackId);
    } catch (e) {
      setError(String(e));
      return;
    }
    await load();
  }, [trackId, load]);

  return { cover, candidates, loading, error, importFromDisk, useCandidate, remove };
}
