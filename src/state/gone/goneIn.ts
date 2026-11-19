/*
 * How many of a set of tracks the gone sheet would list. A track flagged gone on an offline root is kept,
 * not gone, so it is not counted: the doors that lead into the sheet (the album badge and header line)
 * count through here so they never open onto an empty list.
 */

// -- State Imports --
import { useAlbumTracks } from "../organize/store";
import { useGoneLibrary } from "./goneEntry";

// -- Type Imports --
import type { GoneResult } from "./goneGroups";

// One id set per grouping, shared by every caller on the same store state.
const idSets = new WeakMap<GoneResult, Set<number>>();

/** How many of `trackIds` the library-wide grouping lists as gone; 0 while there is no grouping. */
export function goneCountIn(result: GoneResult | null, trackIds: number[]): number {
  if (!result) return 0;
  let ids = idSets.get(result);
  if (!ids) {
    ids = new Set(result.ids);
    idSets.set(result, ids);
  }
  let n = 0;
  for (const id of trackIds) if (ids.has(id)) n += 1;
  return n;
}

/** The gone tracks of one album that the sheet would list. */
export function useAlbumGoneCount(albumId: number): number {
  const result = useGoneLibrary();
  const members = useAlbumTracks(albumId);
  return goneCountIn(
    result,
    members.map((m) => m.track_id),
  );
}
