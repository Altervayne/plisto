/*
 * The pure grouping behind the gone-tracks sheet: tracks whose source file is gone, split into a flat list,
 * a likely-moved block and per-folder groups, for the whole library, one root or one album. Tracks on an
 * offline root are never listed as gone (the drive is away, not the files); the offline roots come back
 * separately. Paths fold with `foldId`, so grouping is stable whatever the platform's separator and case.
 */

// -- State Imports --
import { foldId } from "../files/folderTree";

// -- Type Imports --
import type { AlbumTrackRow, Root, TrackRow } from "../../types";

/** At most this many gone tracks in scope read as a flat list; more are grouped by folder. */
export const FLAT_MAX = 20;
/** A vanished folder with at least this many gone tracks reads as moved. */
export const LIKELY_MOVED_MIN = 10;
/** How many folder groups show before "Show more folders". */
export const GROUP_PAGE = 5;

/** What a sheet or entry looks at: everything, the tracks under one root, or the members of one album. */
export type GoneScope =
  | { kind: "all" }
  | { kind: "root"; rootId: number }
  | { kind: "album"; albumId: number };

export const ALL_GONE: GoneScope = { kind: "all" };

/** One folder and its gone tracks. `id` is folded; `path` is the real-case folder path. */
export interface GoneGroup {
  id: string;
  path: string;
  rootId: number | null;
  tracks: TrackRow[];
}

/**
 * An offline root, with how many tracks in scope on it are flagged gone. `goneCount` can be 0, and the root
 * can hold no tracks at all (`root.track_count`); a surface that lists only roots with tracks behind them
 * filters on `root.track_count > 0`.
 */
export interface OfflineGoneRoot {
  root: Root;
  goneCount: number;
}

export interface GoneResult {
  /** Gone tracks in scope, offline roots excluded. */
  total: number;
  /** The ids of those tracks. */
  ids: number[];
  /** The latest `missing_at` among those tracks, or null when none. */
  newestGoneAt: number | null;
  /** Folders listed: likely-moved folders plus groups. */
  folderCount: number;
  offlineRoots: OfflineGoneRoot[];
  /** Online roots whose every track is gone; their Locate is the root one. */
  fullyGoneRoots: Root[];
  /** Vanished folders holding LIKELY_MOVED_MIN or more gone tracks, largest first. */
  likely: GoneGroup[];
  /** The remaining gone tracks by immediate folder, largest first. */
  groups: GoneGroup[];
  /** The gone tracks by path when few enough to list, else null. */
  flat: TrackRow[] | null;
}

/** A stable key for a scope, for memo lookups. */
export function scopeKey(scope: GoneScope): string {
  if (scope.kind === "root") return `root:${scope.rootId}`;
  if (scope.kind === "album") return `album:${scope.albumId}`;
  return "all";
}

interface RootFold {
  root: Root;
  id: string;
  prefix: string;
  depth: number;
}

function foldRoots(roots: Root[]): RootFold[] {
  return roots
    .map((root) => {
      const id = foldId(root.path);
      return { root, id, prefix: id.endsWith("/") ? id : `${id}/`, depth: id === "/" ? 1 : id.split("/").length };
    })
    .sort((a, b) => b.id.length - a.id.length);
}

/** The deepest root holding a folded path, or null for a path under none. */
function rootOf(folded: string, folds: RootFold[]): RootFold | null {
  for (const fold of folds) if (folded.startsWith(fold.prefix)) return fold;
  return null;
}

/** The real-case path made of the first `segments` segments of `path`. */
function prefixPath(path: string, segments: number): string {
  let seen = 0;
  for (let i = 0; i < path.length; i++) {
    if (path[i] !== "/" && path[i] !== "\\") continue;
    seen += 1;
    if (seen === segments) return path.slice(0, i);
  }
  return path;
}

function byPath(a: TrackRow, b: TrackRow): number {
  const fa = foldId(a.source_path);
  const fb = foldId(b.source_path);
  return fa < fb ? -1 : fa > fb ? 1 : a.id - b.id;
}

function bySize(a: GoneGroup, b: GoneGroup): number {
  return b.tracks.length - a.tracks.length || (a.id < b.id ? -1 : a.id > b.id ? 1 : 0);
}

/**
 * Splits the gone tracks of a scope into the structure the sheet shows. `membership` is read only for an
 * album scope. A folder is "vanished" when no present track sits at or under it; the topmost vanished folder
 * below a root collects the gone tracks under it.
 */
export function groupGone(
  tracks: TrackRow[],
  roots: Root[],
  offlineIds: number[],
  scope: GoneScope,
  membership: AlbumTrackRow[],
): GoneResult {
  const folds = foldRoots(roots);
  const offline = new Set(offlineIds);
  const fullyGone = roots.filter(
    (r) => !offline.has(r.id) && r.track_count > 0 && r.missing_count === r.track_count,
  );
  const fullyGoneIds = new Set(fullyGone.map((r) => r.id));
  const members =
    scope.kind === "album"
      ? new Set(membership.filter((m) => m.album_id === scope.albumId).map((m) => m.track_id))
      : null;

  // Folders at or above a present track, up to the filesystem top: a root nested in another marks the
  // outer root's folders above it as present too.
  const present = new Set<string>();
  const gone: { track: TrackRow; folded: string; fold: RootFold | null }[] = [];
  for (const track of tracks) {
    const folded = foldId(track.source_path);
    const fold = rootOf(folded, folds);
    if (fold && offline.has(fold.root.id)) {
      if (track.missing_at != null && inScope(track, fold, scope, members)) gone.push({ track, folded, fold });
      continue;
    }
    if (track.missing_at == null) {
      if (!fold) continue;
      const segs = folded.split("/");
      for (let depth = segs.length - 1; depth > 0; depth--) {
        const id = segs.slice(0, depth).join("/");
        // An ancestor already seen carries every ancestor above it.
        if (present.has(id)) break;
        present.add(id);
      }
    } else if (inScope(track, fold, scope, members)) {
      gone.push({ track, folded, fold });
    }
  }

  const offlineGone = new Map<number, number>();
  const online: typeof gone = [];
  for (const entry of gone) {
    const id = entry.fold?.root.id;
    if (id != null && offline.has(id)) offlineGone.set(id, (offlineGone.get(id) ?? 0) + 1);
    else online.push(entry);
  }
  const offlineRoots = roots
    .filter((r) => offline.has(r.id) && offlineInScope(r, scope, offlineGone))
    .map((root) => ({ root, goneCount: offlineGone.get(root.id) ?? 0 }));

  // The topmost vanished folder under each gone track's root.
  const vanished = new Map<string, GoneGroup>();
  const inVanished = new Set<number>();
  for (const { track, folded, fold } of online) {
    if (!fold || fullyGoneIds.has(fold.root.id)) continue;
    const segs = folded.split("/");
    for (let depth = fold.depth + 1; depth < segs.length; depth++) {
      const id = segs.slice(0, depth).join("/");
      if (present.has(id)) continue;
      let group = vanished.get(id);
      if (!group) {
        group = { id, path: prefixPath(track.source_path, depth), rootId: fold.root.id, tracks: [] };
        vanished.set(id, group);
      }
      group.tracks.push(track);
      inVanished.add(track.id);
      break;
    }
  }
  const likely: GoneGroup[] = [];
  for (const group of vanished.values()) {
    if (group.tracks.length >= LIKELY_MOVED_MIN) likely.push(group);
    else for (const t of group.tracks) inVanished.delete(t.id);
  }
  likely.sort(bySize);
  for (const group of likely) group.tracks.sort(byPath);

  const byFolder = new Map<string, GoneGroup>();
  for (const { track, folded, fold } of online) {
    if (inVanished.has(track.id)) continue;
    const cut = folded.lastIndexOf("/");
    const id = cut > 0 ? folded.slice(0, cut) : "/";
    let group = byFolder.get(id);
    if (!group) {
      const segments = folded.slice(0, cut).split("/").length;
      group = { id, path: prefixPath(track.source_path, segments), rootId: fold?.root.id ?? null, tracks: [] };
      byFolder.set(id, group);
    }
    group.tracks.push(track);
  }
  const groups = [...byFolder.values()].sort(bySize);
  for (const group of groups) group.tracks.sort(byPath);

  const list = online.map((e) => e.track);
  return {
    total: list.length,
    ids: list.map((t) => t.id),
    newestGoneAt: list.reduce<number | null>(
      (max, t) => (t.missing_at != null && (max == null || t.missing_at > max) ? t.missing_at : max),
      null,
    ),
    folderCount: likely.length + groups.length,
    offlineRoots,
    fullyGoneRoots: fullyGone.filter(
      (r) => scope.kind === "all" || online.some((e) => e.fold?.root.id === r.id),
    ),
    likely,
    groups,
    flat: list.length > 0 && list.length <= FLAT_MAX ? [...list].sort(byPath) : null,
  };
}

function inScope(track: TrackRow, fold: RootFold | null, scope: GoneScope, members: Set<number> | null): boolean {
  if (scope.kind === "root") return fold?.root.id === scope.rootId;
  if (scope.kind === "album") return members?.has(track.id) ?? false;
  return true;
}

/** An offline root belongs to a root scope when it is that root, and to an album scope when it holds a gone member. */
function offlineInScope(root: Root, scope: GoneScope, goneByRoot: Map<number, number>): boolean {
  if (scope.kind === "root") return scope.rootId === root.id;
  if (scope.kind === "album") return goneByRoot.has(root.id);
  return true;
}

/** The groups a page shows, with how many folders and tracks stay hidden behind "Show more folders". */
export function pageGroups(
  groups: GoneGroup[],
  shown: number,
): { visible: GoneGroup[]; hiddenFolders: number; hiddenTracks: number } {
  const visible = groups.slice(0, shown);
  const hidden = groups.slice(shown);
  return {
    visible,
    hiddenFolders: hidden.length,
    hiddenTracks: hidden.reduce((n, g) => n + g.tracks.length, 0),
  };
}
