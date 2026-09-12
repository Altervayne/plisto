/*
 * The card wall's windowing math: how many tiles fit a row, how the sorted rows chunk into card-rows,
 * and how grouped cards flatten into the header-and-card-row list the virtualizer renders. Pure data,
 * no React and no store, so the wall and the tests read one source. A card-row is the grid analogue of
 * a list row: the virtualizer windows over card-rows, not single tiles, so one card wall of tens of
 * thousands of tracks mounts only the visible band.
 */

// -- Type Imports --
import type { TrackGroup } from "./trackGrouping";
import type { TrackRow } from "../../types";

/** A flattened card entry: a full-width group header, or one card-row of tiles under a group. `row` is
 *  the card-row's index within its group, so a key built from it survives a collapse above it. */
export type CardItem =
  | { type: "header"; group: TrackGroup }
  | { type: "cardRow"; groupKey: string; row: number; tracks: TrackRow[] };

/**
 * The number of fixed-width tiles that fit a content width, given the tile width and the gutter between
 * tiles. The width is the tiles' own content box, so no page padding is folded in here. Never below one,
 * so a pane narrower than a tile still shows a single column.
 */
export function columnCount(width: number, tile: number, gutter: number): number {
  if (width <= 0) return 1;
  return Math.max(1, Math.floor((width + gutter) / (tile + gutter)));
}

/** Slices a list into runs of at most `size`, preserving order. A size below one collapses to one run. */
export function chunk<T>(items: T[], size: number): T[][] {
  const step = Math.max(1, size);
  const out: T[][] = [];
  for (let i = 0; i < items.length; i += step) out.push(items.slice(i, i + step));
  return out;
}

/**
 * Flattens the groups into the card list the virtualizer renders: each group's header, then its rows
 * chunked into card-rows of `cols` tiles, unless the group is collapsed, in which case only the header
 * shows. Mirrors flattenGroups, but a group's rows fold into card-rows rather than one row each.
 */
export function flattenCardGroups(
  groups: TrackGroup[],
  collapsed: Set<string>,
  cols: number,
): CardItem[] {
  const items: CardItem[] = [];
  for (const group of groups) {
    items.push({ type: "header", group });
    if (collapsed.has(group.key)) continue;
    chunk(group.rows, cols).forEach((tracks, row) => {
      items.push({ type: "cardRow", groupKey: group.key, row, tracks });
    });
  }
  return items;
}
