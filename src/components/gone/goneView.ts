/*
 * The shape the gone sheet draws, derived from a grouping: offline roots with tracks behind them, online
 * roots whose every track is gone (one root Locate fixes them), likely-moved folders, and the other
 * folders. A fully gone root's tracks leave the folder list and sit under its own block, so every track is
 * counted once and the header totals agree with the rows.
 */

// -- State Imports --
import { FLAT_MAX } from "../../state/gone/goneGroups";
import { foldId } from "../../state/files/folderTree";
import type { GoneGroup, GoneResult, OfflineGoneRoot } from "../../state/gone/goneGroups";

// -- Type Imports --
import type { Root, TrackRow } from "../../types";

/** An online root with every track gone, and the gone tracks of it in scope. */
export interface MovedRoot {
  root: Root;
  tracks: TrackRow[];
}

export interface GoneView {
  /** Offline roots that hold tracks; an empty root has nothing to keep or locate. */
  offline: OfflineGoneRoot[];
  moved: MovedRoot[];
  likely: GoneGroup[];
  groups: GoneGroup[];
  /** Tracks listed flat when few enough, else null. */
  flat: TrackRow[] | null;
  total: number;
  folders: number;
}

/** How many tracks an expanded folder lists before "Show more tracks", and how many each press adds. */
export const TRACK_PAGE = 50;
/** How many folders each "Show more folders" press adds after the first page. */
export const GROUP_STEP = 50;

/** Splits a grouping into the blocks and lists the sheet draws. A flat result carries no blocks. */
export function buildView(result: GoneResult): GoneView {
  const offline = result.offlineRoots.filter((o) => o.root.track_count > 0);
  const goneRoots = new Map(result.fullyGoneRoots.map((r) => [r.id, r] as const));
  const movedTracks = new Map<number, TrackRow[]>();
  const groups: GoneGroup[] = [];
  for (const group of result.groups) {
    if (group.rootId != null && goneRoots.has(group.rootId)) {
      const list = movedTracks.get(group.rootId) ?? [];
      list.push(...group.tracks);
      movedTracks.set(group.rootId, list);
    } else {
      groups.push(group);
    }
  }
  const moved = [...movedTracks.entries()]
    .map(([id, tracks]) => ({ root: goneRoots.get(id) as Root, tracks }))
    .sort((a, b) => b.tracks.length - a.tracks.length || a.root.id - b.root.id);
  // The likely-moved and moved blocks always lead. What is left lists flat when few, else by folder.
  const rest = groups.flatMap((g) => g.tracks);
  const flat = rest.length > 0 && rest.length <= FLAT_MAX ? [...rest].sort(byPath) : null;
  return {
    offline,
    moved,
    likely: result.likely,
    groups: flat ? [] : groups,
    flat,
    total: result.total,
    folders: moved.length + result.likely.length + (flat ? folderCount(flat) : groups.length),
  };
}

function byPath(a: TrackRow, b: TrackRow): number {
  const fa = foldId(a.source_path);
  const fb = foldId(b.source_path);
  return fa < fb ? -1 : fa > fb ? 1 : a.id - b.id;
}

/**
 * The header's numbers: every gone track, and the folders holding them. A flat list with no block above it
 * is just a track count, so `folders` is null there.
 */
export function summaryParts(view: GoneView): { tracks: number; folders: number | null } {
  const blocks = view.moved.length + view.likely.length > 0;
  return { tracks: view.total, folders: view.flat && !blocks ? null : view.folders };
}

/** How many distinct folders a list of tracks sits in. */
function folderCount(tracks: TrackRow[]): number {
  return new Set(tracks.map((t) => foldId(t.source_path).replace(/\/[^/]*$/, ""))).size;
}

/** The ids of a list of tracks, in order. */
export function idsOf(tracks: TrackRow[]): number[] {
  return tracks.map((t) => t.id);
}
