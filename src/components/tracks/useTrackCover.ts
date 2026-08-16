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
  saveTrackCover,
  trackCoverExt,
} from "../../lib/ipc";
import { pickCoverSavePath, pickImageFile } from "../../lib/dialog";

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
  saveToDisk: (nameFor: (ext: string) => string, failMessage: string) => Promise<void>;
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
export function useTrackCover(trackId: number, keepOwn = false): TrackCover {
  const [cover, setCover] = useState<CoverView | null>(null);
  const [candidates, setCandidates] = useState<CandidateView[]>([]);
  // Start loading: a load always fires on mount, so the surface never flashes "no cover" first.
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<string | null>(null);
  const requestId = useRef(0);

  const load = useCallback(async (): Promise<void> => {
    const id = ++requestId.current;
    setLoading(true);
    setError(null);
    try {
      const [ref, cands] = await Promise.all([
        // keepOwn mirrors the membership flag: a flagged track resolves its own art here, not the
        // shared folder cover, so toggling keep-own reloads and the peek shows the track's own art.
        readCover(trackId, "detail", keepOwn),
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
  }, [trackId, keepOwn]);

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

  const saveToDisk = useCallback(
    // The message is passed in localized: the surface holds the translator, this hook only the IPC.
    // The name builder gets the art's real extension so the dialog defaults to the true format; a
    // failed sniff falls back to jpg rather than blocking the save.
    async (nameFor: (ext: string) => string, failMessage: string): Promise<void> => {
      let ext = "jpg";
      try {
        ext = (await trackCoverExt(trackId)) ?? "jpg";
      } catch {
        // Keep the safe default and carry on to the picker.
      }
      const path = await pickCoverSavePath(nameFor(ext));
      if (!path) return;
      try {
        await saveTrackCover(trackId, path);
      } catch {
        setError(failMessage);
      }
    },
    [trackId],
  );

  return { cover, candidates, loading, error, importFromDisk, useCandidate, remove, saveToDisk };
}
