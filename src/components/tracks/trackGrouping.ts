/*
 * The grid's grouping pass: a final presentational fold over rows the caller has already filtered and
 * sorted, so grouping composes on top of the facet chips, the search, and the column sort. Pure data,
 * no React and no store, so the grid and the tests read one source. Genre is multi-valued: a track
 * lands under each of its genres, so the group counts sum to more than the row total by design.
 */

// -- Utils Imports --
import { resolveFacet, sortValues, trackGenreNames } from "./trackFacets";

// -- Type Imports --
import type { FacetKey } from "./trackFacets";
import type { TrackRow } from "../../types";

/** The bucket key for rows with no value on the grouped dimension. Never a real tag: a resolved facet
 *  folds an empty value to null and a genre name is always non-empty, so this cannot collide. */
export const UNTAGGED_KEY = "";

/** One rendered group: its bucket key, its display label, and the rows under it in their sorted order. */
export interface TrackGroup {
  key: string;
  label: string;
  rows: TrackRow[];
}

/** A flattened list entry: a group header, or one row tagged with the group it renders under. */
export type GroupItem =
  | { type: "header"; group: TrackGroup }
  | { type: "row"; track: TrackRow; groupKey: string };

/**
 * Buckets the already-sorted rows under one dimension, preserving their order within each group. A
 * single-tag facet reads its resolved value; genre reads the vocabulary membership, so a multi-genre
 * track appears once per genre. A row with no value on the dimension falls to the untagged bucket, which
 * sorts last; the untagged group carries an empty label the renderer localizes.
 */
export function groupRows(
  rows: TrackRow[],
  groupBy: FacetKey,
  genreNameById: Map<number, string>,
): TrackGroup[] {
  const buckets = new Map<string, TrackRow[]>();
  const push = (key: string, track: TrackRow) => {
    const bucket = buckets.get(key);
    if (bucket) bucket.push(track);
    else buckets.set(key, [track]);
  };

  for (const track of rows) {
    if (groupBy === "genre") {
      const names = trackGenreNames(track, genreNameById);
      if (names.length === 0) push(UNTAGGED_KEY, track);
      else for (const name of names) push(name, track);
    } else {
      push(resolveFacet(track, groupBy) ?? UNTAGGED_KEY, track);
    }
  }

  // Order tagged keys by the facet menu ordering; the untagged bucket always trails.
  const tagged = [...buckets.keys()].filter((key) => key !== UNTAGGED_KEY);
  const keys = sortValues(groupBy, new Set(tagged));
  if (buckets.has(UNTAGGED_KEY)) keys.push(UNTAGGED_KEY);

  return keys.map((key) => ({
    key,
    label: key === UNTAGGED_KEY ? "" : key,
    rows: buckets.get(key) ?? [],
  }));
}

/** Flattens the groups into the list the virtualizer renders: each group's header, then its rows unless
 *  the group is collapsed, in which case only the header shows. */
export function flattenGroups(groups: TrackGroup[], collapsed: Set<string>): GroupItem[] {
  const items: GroupItem[] = [];
  for (const group of groups) {
    items.push({ type: "header", group });
    if (collapsed.has(group.key)) continue;
    for (const track of group.rows) items.push({ type: "row", track, groupKey: group.key });
  }
  return items;
}
