/*
 * Possible-duplicate detection: present tracks sharing a folded title and artist whose lengths sit
 * within two seconds of the first one in their run. Matching is deliberately literal - "(Live)",
 * "Remastered" or "feat." variants keep their own key, so they never match the plain take. Dismissed
 * pairs cut edges, so a cluster shows only through what is still undismissed, and a cluster with every
 * pair dismissed comes back separately for the Restore list. Pure and deterministic.
 */

// -- Utils Imports --
import { fold } from "../../lib/fold";

// -- Type Imports --
import type { DismissedPair, TrackRow } from "../../types";

/** Lengths further apart than this from the first copy of a run start a new run. */
const DURATION_WINDOW_SECS = 2.0;

/** One set of possible duplicates. */
export interface DuplicateGroup {
  // The member ids joined, the group's identity across recomputes.
  key: string;
  // Orders groups: the folded title and artist, then the lowest member id.
  sortKey: string;
  // The shared title and artist as the lowest-id member spells them.
  title: string;
  artist: string;
  // Member ids, ascending.
  trackIds: number[];
  // Members with another member of the same size and format, ascending.
  identicalIds: number[];
}

/** The shown groups and the fully dismissed ones, each in group order. */
export interface DuplicateResult {
  groups: DuplicateGroup[];
  dismissed: DuplicateGroup[];
}

/** The edit-over-raw value, or null when neither layer holds a non-blank one. */
function effective(edit: string | null, raw: string | null): string | null {
  const value = edit ?? raw;
  return value != null && fold(value) !== "" ? value : null;
}

function pairKey(a: number, b: number): string {
  return a < b ? `${a}:${b}` : `${b}:${a}`;
}

/** Splits a key bucket into duration runs anchored on each run's first copy. */
function clusterByDuration(bucket: TrackRow[]): TrackRow[][] {
  const sorted = [...bucket].sort(
    (a, b) => (a.duration_secs as number) - (b.duration_secs as number) || a.id - b.id,
  );
  const clusters: TrackRow[][] = [];
  let current: TrackRow[] = [];
  for (const track of sorted) {
    const anchor = current[0];
    const spread = anchor ? (track.duration_secs as number) - (anchor.duration_secs as number) : 0;
    if (spread > DURATION_WINDOW_SECS) {
      clusters.push(current);
      current = [];
    }
    current.push(track);
  }
  if (current.length > 0) clusters.push(current);
  return clusters.filter((c) => c.length >= 2);
}

/** The connected components of the undismissed-pair graph, those of two or more only. */
function undismissedComponents(members: TrackRow[], dismissed: Set<string>): TrackRow[][] {
  const seen = new Set<number>();
  const components: TrackRow[][] = [];
  for (const start of members) {
    if (seen.has(start.id)) continue;
    seen.add(start.id);
    const component = [start];
    for (let i = 0; i < component.length; i += 1) {
      const from = component[i];
      for (const to of members) {
        if (seen.has(to.id) || dismissed.has(pairKey(from.id, to.id))) continue;
        seen.add(to.id);
        component.push(to);
      }
    }
    if (component.length >= 2) components.push(component);
  }
  return components;
}

function toGroup(
  members: TrackRow[],
  bucketKey: string,
  titleOf: Map<number, [string, string]>,
): DuplicateGroup {
  const ordered = [...members].sort((a, b) => a.id - b.id);
  const ids = ordered.map((t) => t.id);
  const identicalIds = ordered
    .filter((t) =>
      ordered.some((o) => o.id !== t.id && o.size_bytes === t.size_bytes && o.ext === t.ext),
    )
    .map((t) => t.id);
  const [title, artist] = titleOf.get(ids[0]) as [string, string];
  return {
    key: ids.join(","),
    sortKey: `${bucketKey}\u0000${String(ids[0]).padStart(12, "0")}`,
    title,
    artist,
    trackIds: ids,
    identicalIds,
  };
}

function byGroupOrder(a: DuplicateGroup, b: DuplicateGroup): number {
  return a.sortKey < b.sortKey ? -1 : a.sortKey > b.sortKey ? 1 : 0;
}

/** Every possible-duplicate group among the tracks, split into shown and fully dismissed. */
export function findDuplicates(tracks: TrackRow[], dismissals: DismissedPair[]): DuplicateResult {
  const dismissed = new Set(dismissals.map((p) => pairKey(p.track_lo, p.track_hi)));
  const buckets = new Map<string, TrackRow[]>();
  const titleOf = new Map<number, [string, string]>();

  for (const track of tracks) {
    if (track.missing_at != null || track.duration_secs == null) continue;
    const title = effective(track.title_edit, track.raw_title);
    const artist = effective(track.artist_edit, track.raw_artist);
    if (title == null || artist == null) continue;
    const key = `${fold(title)}\u0000${fold(artist)}`;
    titleOf.set(track.id, [title, artist]);
    const bucket = buckets.get(key);
    if (bucket) bucket.push(track);
    else buckets.set(key, [track]);
  }

  const result: DuplicateResult = { groups: [], dismissed: [] };
  for (const [bucketKey, bucket] of buckets) {
    if (bucket.length < 2) continue;
    for (const cluster of clusterByDuration(bucket)) {
      const components = undismissedComponents(cluster, dismissed);
      // No component left means no undismissed pair at all: the whole cluster was dismissed.
      if (components.length === 0) result.dismissed.push(toGroup(cluster, bucketKey, titleOf));
      for (const c of components) result.groups.push(toGroup(c, bucketKey, titleOf));
    }
  }
  result.groups.sort(byGroupOrder);
  result.dismissed.sort(byGroupOrder);
  return result;
}
