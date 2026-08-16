// -- Framework Imports --
import { useMemo } from "react";

// -- State Imports --
import { useTracks } from "../../state/store";
import { foldId, parentId } from "../../state/files/folderTree";

// -- Type Imports --
import type { TrackRow } from "../../types";

/**
 * The non-missing tracks sitting directly in `folderPath`: their parent directory folds to exactly the
 * folder identity. Folded compare so the real-case walk path matches the folded source paths regardless
 * of platform. A gone-from-disk track is left out - it can carry no cover to set.
 */
export function tracksInFolder(tracks: TrackRow[], folderPath: string): TrackRow[] {
  const target = foldId(folderPath);
  return tracks.filter(
    (t) => t.missing_at == null && parentId(foldId(t.source_path)) === target,
  );
}

/** The reactive view of `tracksInFolder` over the live tracks store. */
export function useFolderTracks(folderPath: string): TrackRow[] {
  const tracks = useTracks();
  return useMemo(() => tracksInFolder(tracks, folderPath), [tracks, folderPath]);
}
