/*
 * What a reader of the album and playlist projections asks first: has the first read landed. "loading" is
 * the quiet wait; "stalled" is the same wait past the stall threshold. Each hook returns one string, so a
 * subscriber re-renders only when the state itself changes.
 */

// -- State Imports --
import { useOrganizeStore } from "./organize/store";
import { usePlaylistsStore } from "./playlists/store";

export type ProjectionState = "ready" | "loading" | "stalled";

function toState(ready: boolean, stalled: boolean): ProjectionState {
  if (ready) return "ready";
  return stalled ? "stalled" : "loading";
}

/** Both states at once: ready only when both are, stalled when either waiting one has stalled. */
export function combineStates(a: ProjectionState, b: ProjectionState): ProjectionState {
  if (a === "ready" && b === "ready") return "ready";
  return a === "stalled" || b === "stalled" ? "stalled" : "loading";
}

export const useOrgStatus = (): ProjectionState =>
  useOrganizeStore((s) => toState(s.orgReady, s.orgStalled));

export const usePlaylistsStatus = (): ProjectionState =>
  usePlaylistsStore((s) => toState(s.ready, s.stalled));

export const useProjectionStatus = (): ProjectionState =>
  combineStates(useOrgStatus(), usePlaylistsStatus());
