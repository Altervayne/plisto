// -- Framework Imports --
import { useMemo, useRef } from "react";
import type { CSSProperties, ReactNode } from "react";

// -- Library Imports --
import {
  getCoreRowModel,
  getFilteredRowModel,
  getSortedRowModel,
  useReactTable,
} from "@tanstack/react-table";
import { useVirtualizer } from "@tanstack/react-virtual";

// -- Component Imports --
import { ScrollArea } from "../common/ScrollArea/ScrollArea";
import { SearchField } from "../common/SearchField";
import { TrackGridHeader } from "./TrackGridHeader";
import { TrackRow } from "./TrackRow";

// -- State Imports --
import {
  useGridFilter,
  useGridSort,
  useSetGridFilter,
  useSetGridSort,
  useTracks,
} from "../../state/store";
import {
  useAddSelection,
  useRemoveSelection,
  useSelectRange,
  useSelection,
  useToggleSelect,
} from "../../state/organize/store";

// -- Type Imports --
import type { SelectModifiers } from "./TrackRow";

// -- Utils Imports --
import { gridTemplate, toColumnDefs, trackGlobalFilter } from "./trackColumns";

// -- Type Imports --
import type { TrackRow as TrackRowData } from "../../types";

// -- i18n Imports --
import { useT } from "../../i18n";

// -- Style Imports --
import styles from "./TrackGrid.module.css";

const ROW_HEIGHT = 40;

/**
 * The track grid: TanStack Table holds the sorted and filtered row model over the loaded rows,
 * TanStack Virtual windows the DOM to the visible slice. Sort and search state live here; the
 * search pill and the persistent summary share the toolbar above the header. A row click reports
 * its track up for the detail peek. A `tracks` list scopes the grid to a subset (a folder view);
 * without it the grid spans the whole index.
 */
export function TrackGrid({
  tracks,
  summary,
  selectedId,
  onSelect,
}: {
  tracks?: TrackRowData[];
  summary?: ReactNode;
  selectedId: number | null;
  onSelect: (track: TrackRowData) => void;
}) {
  const allTracks = useTracks();
  const t = useT();
  const data = tracks ?? allTracks;
  const columns = useMemo(() => toColumnDefs(), []);
  const template = useMemo(() => gridTemplate(), []);

  // Sort and search live in the store so a re-scan, which unmounts this grid, keeps them.
  const sorting = useGridSort();
  const globalFilter = useGridFilter();
  const setSorting = useSetGridSort();
  const setGlobalFilter = useSetGridFilter();

  const table = useReactTable({
    data,
    columns,
    state: { sorting, globalFilter },
    onSortingChange: (updater) =>
      setSorting(typeof updater === "function" ? updater(sorting) : updater),
    onGlobalFilterChange: (updater) =>
      setGlobalFilter(typeof updater === "function" ? updater(globalFilter) : updater),
    globalFilterFn: trackGlobalFilter,
    // The default decides a column is searchable by sniffing the first row's value, which drops
    // title/artist/album the moment the first file is untagged - the common case in a messy
    // library. Gate on each column's enableGlobalFilter instead.
    getColumnCanGlobalFilter: () => true,
    getCoreRowModel: getCoreRowModel(),
    getSortedRowModel: getSortedRowModel(),
    getFilteredRowModel: getFilteredRowModel(),
  });

  const rows = table.getRowModel().rows;

  // Selection is keyed by track_id in the store, so it survives sort and filter. The anchor is a
  // row's index in the current sorted/filtered view, so a shift-range respects the order on screen.
  const selection = useSelection();
  const toggleSelect = useToggleSelect();
  const selectRange = useSelectRange();
  const addSelection = useAddSelection();
  const removeSelection = useRemoveSelection();
  const anchorRef = useRef<number | null>(null);
  const selecting = selection.size > 0;

  // The tri-state over the current view: every row selected, some, or none. The select-all control
  // adds or removes only these rows, so selections held in other folders ride through untouched.
  const rowIds = rows.map((r) => r.original.id);
  const selectedInView = rowIds.reduce((n, id) => (selection.has(id) ? n + 1 : n), 0);
  const selectAll =
    rowIds.length > 0 && selectedInView === rowIds.length
      ? "all"
      : selectedInView > 0
        ? "some"
        : "none";
  const onToggleAll = () => {
    if (selectAll === "all") removeSelection(rowIds);
    else addSelection(rowIds);
  };

  const handleToggle = (trackId: number, mods: SelectModifiers) => {
    const index = rows.findIndex((r) => r.original.id === trackId);
    if (mods.shift && anchorRef.current != null) {
      const anchor = anchorRef.current;
      const [lo, hi] = anchor <= index ? [anchor, index] : [index, anchor];
      selectRange(rows.slice(lo, hi + 1).map((r) => r.original.id));
      return;
    }
    toggleSelect(trackId);
    anchorRef.current = index;
  };

  // The ScrollArea hands its viewport here, so the virtualizer scrolls the bespoke surface.
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const virtualizer = useVirtualizer({
    count: rows.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 8,
  });

  const headers = table.getHeaderGroups()[0]?.headers ?? [];
  const noMatch = rows.length === 0 && globalFilter.trim().length > 0;

  return (
    <div className={styles.grid} style={{ "--track-cols": template } as CSSProperties}>
      <div className={styles.toolbar}>
        <div className={styles.search}>
          <SearchField
            value={globalFilter}
            onChange={setGlobalFilter}
            placeholder={t((d) => d.tracks.search)}
          />
        </div>
        {summary ? <div className={styles.summary}>{summary}</div> : null}
      </div>

      <TrackGridHeader headers={headers} selectAll={selectAll} onToggleAll={onToggleAll} />

      <ScrollArea className={styles.scroll} contentClassName={styles.scrollInner} viewportRef={scrollRef}>
        {noMatch ? (
          <p className={styles.noMatch}>
            {t((d) => d.tracks.noMatch, { q: globalFilter.trim() })}
          </p>
        ) : (
          <div className={styles.body} style={{ height: virtualizer.getTotalSize() }}>
            {virtualizer.getVirtualItems().map((item) => {
              const track = rows[item.index].original;
              return (
                <TrackRow
                  key={track.id}
                  track={track}
                  active={track.id === selectedId}
                  selected={selection.has(track.id)}
                  selecting={selecting}
                  onSelect={onSelect}
                  onToggle={handleToggle}
                  style={{ transform: `translateY(${item.start}px)` }}
                />
              );
            })}
          </div>
        )}
      </ScrollArea>
    </div>
  );
}
