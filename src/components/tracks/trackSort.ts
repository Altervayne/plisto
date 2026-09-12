/*
 * Card mode's sort model: the fields the card wall can sort on, each mapped to the list column that
 * carries the same value. Both modes drive one GridSort, so a sort chosen on the cards reads back on
 * the list header and the reverse. Pure data, no React and no store, so the control and the tests read
 * one source.
 */

// -- Type Imports --
import type { TrackColumnId } from "./trackColumns";
import type { GridSort } from "../../state/store";

/** The sortable fields offered in card mode, in menu order. */
export type SortField = "title" | "artist" | "album" | "year" | "duration";

/** The fields in menu order. */
export const SORT_FIELDS: SortField[] = ["title", "artist", "album", "year", "duration"];

/** Each field's list column id, so a card sort and a header sort share one GridSort. */
export const SORT_COLUMN: Record<SortField, TrackColumnId> = {
  title: "raw_title",
  artist: "raw_artist",
  album: "raw_album",
  year: "raw_year",
  duration: "duration_secs",
};

const FIELD_BY_COLUMN = new Map<string, SortField>(
  SORT_FIELDS.map((field) => [SORT_COLUMN[field], field]),
);

/** The active card field and direction read from the shared sort: its first term, when that term maps
 *  to a card field. Null when unsorted or sorted on a column cards do not offer. */
export function activeSort(sort: GridSort): { field: SortField; desc: boolean } | null {
  const term = sort[0];
  if (!term) return null;
  const field = FIELD_BY_COLUMN.get(term.id);
  return field ? { field, desc: term.desc } : null;
}

/** The GridSort for a field and direction: a single term on that field's column. */
export function applySort(field: SortField, desc: boolean): GridSort {
  return [{ id: SORT_COLUMN[field], desc }];
}
