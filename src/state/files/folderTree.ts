/*
 * The virtual folder tree over the scanned tracks: a pure derivation from the in-memory rows, no
 * backend and no path parsing anywhere but here. Identity and display are kept apart on purpose.
 * Identity folds a path to lowercase forward-slashes with no trailing slash, so grouping, scope
 * compares, and startsWith are stable client-side regardless of platform. Display names read the
 * real-case segment from a descendant's display_path, since all descendants of a real folder share
 * its real-case ancestor names.
 */

// -- Type Imports --
import type { TrackRow } from "../../types";

/** One folder in the tree at a given scope. `id` is folded; `name` is the real-case segment. */
export interface FolderNode {
  id: string;
  name: string;
  trackCount: number;
  subfolderCount: number;
}

/** One breadcrumb step from the root down to the scope. `id` is folded; `name` is real-case. */
export interface Crumb {
  id: string;
  name: string;
}

/** Folds any path to the client-side identity: lowercase, forward slashes, no trailing slash. */
export function foldId(p: string): string {
  const folded = p.toLowerCase().replace(/\\/g, "/");
  return folded.length > 1 && folded.endsWith("/") ? folded.slice(0, -1) : folded;
}

/** The parent directory of a folded path. A filesystem root maps to itself (no parent). */
export function parentId(id: string): string {
  const cut = id.lastIndexOf("/");
  if (cut < 0) return id;
  if (cut === 0) return "/";
  return id.slice(0, cut);
}

/** The last folded segment of a path, used as the name fallback when no display_path is present. */
function lastSegment(id: string): string {
  const cut = id.lastIndexOf("/");
  return cut < 0 ? id : id.slice(cut + 1);
}

/** The zero-based segment index of a folder's own name within a split path. */
function segmentIndex(folderId: string): number {
  return foldId(folderId).split("/").length - 1;
}

/**
 * The real-case name of `folderId`, read from any descendant's display_path at the folder's depth.
 * Falls back to the folded last segment when no descendant carries a display_path yet.
 */
function nameAt(tracks: TrackRow[], folderId: string): string {
  const idx = segmentIndex(folderId);
  const prefix = folderId + "/";
  for (const t of tracks) {
    if (!foldId(t.source_path).startsWith(prefix)) continue;
    if (t.display_path == null) continue;
    const name = t.display_path.split(/[\\/]/)[idx];
    if (name != null && name !== "") return name;
  }
  return lastSegment(folderId);
}

/** The number of distinct immediate subfolders of `folderId` among the given descendant rows. */
function immediateSubfolderCount(members: TrackRow[], folderId: string): number {
  const prefix = folderId + "/";
  const subs = new Set<string>();
  for (const t of members) {
    const rel = foldId(t.source_path).slice(prefix.length);
    const slash = rel.indexOf("/");
    if (slash >= 0) subs.add(rel.slice(0, slash));
  }
  return subs.size;
}

/**
 * The immediate subfolders of `scopeId`: the distinct next segment below scope among all descendant
 * tracks. Each node rolls up every descendant track under it, counts only its immediate subfolders,
 * and takes its real-case name. A file sitting directly in scope makes no folder. Sorted by name,
 * case-insensitive.
 */
export function childFolders(tracks: TrackRow[], scopeId: string): FolderNode[] {
  const prefix = scopeId + "/";
  const groups = new Map<string, TrackRow[]>();
  for (const t of tracks) {
    const folded = foldId(t.source_path);
    if (!folded.startsWith(prefix)) continue;
    const rel = folded.slice(prefix.length);
    const slash = rel.indexOf("/");
    // No slash below scope means an immediate file, not a subfolder.
    if (slash < 0) continue;
    const childId = prefix + rel.slice(0, slash);
    const members = groups.get(childId);
    if (members) members.push(t);
    else groups.set(childId, [t]);
  }

  const nodes: FolderNode[] = [];
  for (const [id, members] of groups) {
    nodes.push({
      id,
      name: nameAt(members, id),
      trackCount: members.length,
      subfolderCount: immediateSubfolderCount(members, id),
    });
  }
  nodes.sort((a, b) => a.name.localeCompare(b.name, undefined, { sensitivity: "base" }));
  return nodes;
}

/** The tracks sitting directly in `scopeId`: their parent directory folds to exactly the scope. */
export function immediateTracks(tracks: TrackRow[], scopeId: string): TrackRow[] {
  return tracks.filter((t) => parentId(foldId(t.source_path)) === scopeId);
}

/** Every track under `scopeId`, at any depth. At the workspace root this is the whole index. */
export function descendantTracks(tracks: TrackRow[], scopeId: string): TrackRow[] {
  const prefix = scopeId + "/";
  return tracks.filter((t) => foldId(t.source_path).startsWith(prefix));
}

/**
 * The breadcrumb from `rootId` down to `scopeId`, inclusive. Walks up by parent from the scope until
 * it reaches the root, then reverses. Each crumb takes its real-case name; the root crumb's name is
 * the workspace root's own last real-case segment.
 */
export function breadcrumb(tracks: TrackRow[], rootId: string, scopeId: string): Crumb[] {
  const chain: string[] = [];
  let cur = scopeId;
  while (true) {
    chain.push(cur);
    if (cur === rootId) break;
    const parent = parentId(cur);
    // A scope that is not under the root would loop; the fs-root fixpoint stops it.
    if (parent === cur) break;
    cur = parent;
  }
  chain.reverse();
  return chain.map((id) => ({ id, name: nameAt(tracks, id) }));
}
