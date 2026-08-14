/*
 * The grid's column model, in one place so the header and the rows render from the same source.
 * Plain data plus the derived TanStack column defs; no JSX lives here. Widths drive a single CSS
 * grid template shared by the header and every row, so columns line up without a table element.
 */

// -- Library Imports --
import type { ColumnDef, FilterFn } from "@tanstack/react-table";

// -- Utils Imports --
import { formatDuration } from "../../lib/format";

// -- Type Imports --
import type { TrackRow } from "../../types";

/** The ink weight a cell carries: the one title anchor, the secondary tags, or quiet meta. */
export type CellInk = "primary" | "secondary" | "meta";

/** How a column's text sits horizontally. Numerics align right so digits stack. */
export type CellAlign = "left" | "right";

/** The visible columns, by row key. Doubles as the key into the localized header labels. */
export type TrackColumnId =
  | "raw_track_no"
  | "raw_title"
  | "raw_artist"
  | "raw_album"
  | "raw_year"
  | "duration_secs"
  | "ext"
  | "filename";

/** One visible column: its row key, track width, and how its cell reads. Labels live in the dict. */
export interface TrackColumn {
  id: TrackColumnId;
  /** Fixed track width in px for meta and numeric columns; null lets a text column flex. */
  width: number | null;
  /** Flex weight when width is null, so title claims more room than artist or album. */
  grow: number;
  align: CellAlign;
  ink: CellInk;
  /** The lone mono cell marks the raw source filename. */
  mono?: boolean;
  /** Digits that stack down the column align via tabular-nums. */
  tabular?: boolean;
  /** The format tag reads as an uppercase micro-label, not a chip and not mono. */
  upper?: boolean;
  /** Turns a raw value into its display string; a plain value falls through to a dash for null. */
  format?: (value: TrackRow[keyof TrackRow]) => string;
  /** Whether the global search reaches this column. Only the text tags and filename do. */
  searchable?: boolean;
  /**
   * Pulls the effective value from the whole row, resolving `edit ?? raw` for the edited columns.
   * Absent columns read their plain `id` field. The cell, the sort, and the search all read through
   * this, so the grid shows and acts on the edited value, not the raw tag.
   */
  resolve?: (track: TrackRow) => TrackRow[keyof TrackRow];
}

/** Left-to-right column order for the default row. Album artist, disc, and genre live in the peek. */
export const trackColumns: TrackColumn[] = [
  { id: "raw_track_no", width: 52, grow: 0, align: "right", ink: "meta", tabular: true },
  {
    id: "raw_title",
    width: null,
    grow: 2,
    align: "left",
    ink: "primary",
    searchable: true,
    resolve: (t) => t.title_edit ?? t.raw_title,
  },
  {
    id: "raw_artist",
    width: null,
    grow: 1.4,
    align: "left",
    ink: "secondary",
    searchable: true,
    resolve: (t) => t.artist_edit ?? t.raw_artist,
  },
  {
    id: "raw_album",
    width: null,
    grow: 1.4,
    align: "left",
    ink: "secondary",
    searchable: true,
    resolve: (t) => t.album_edit ?? t.raw_album,
  },
  {
    id: "raw_year",
    width: 60,
    grow: 0,
    align: "right",
    ink: "meta",
    tabular: true,
    resolve: (t) => t.year_edit ?? t.raw_year,
  },
  {
    id: "duration_secs",
    width: 72,
    grow: 0,
    align: "right",
    ink: "meta",
    tabular: true,
    format: (value) => formatDuration(value as number | null),
  },
  { id: "ext", width: 78, grow: 0, align: "left", ink: "meta", upper: true },
  { id: "filename", width: null, grow: 1.6, align: "left", ink: "meta", mono: true, searchable: true },
];

/** The shared `grid-template-columns` value: fixed px for meta, `fr` weights for flexing text. */
export function gridTemplate(columns: TrackColumn[] = trackColumns): string {
  return columns
    .map((col) => (col.width == null ? `minmax(0, ${col.grow}fr)` : `${col.width}px`))
    .join(" ");
}

/** Case-insensitive substring match, run only over the columns flagged searchable. */
export const trackGlobalFilter: FilterFn<TrackRow> = (row, columnId, value) => {
  const cell = row.getValue(columnId);
  if (cell == null) return false;
  return String(cell).toLowerCase().includes(String(value).toLowerCase());
};

/** Derives the TanStack column defs from the visible columns: sorting on all, search on the text tags. */
export function toColumnDefs(columns: TrackColumn[] = trackColumns): ColumnDef<TrackRow>[] {
  return columns.map((col) => {
    // The id stays the stable column key and the header's dict lookup; only the accessor differs. An
    // edited column resolves `edit ?? raw` so sort and search read the effective value the cell
    // shows, while a plain column keeps its raw field key.
    const shared = {
      id: col.id,
      header: col.id,
      enableSorting: true,
      enableGlobalFilter: col.searchable ?? false,
    };
    return col.resolve
      ? { ...shared, accessorFn: col.resolve }
      : { ...shared, accessorKey: col.id };
  });
}
