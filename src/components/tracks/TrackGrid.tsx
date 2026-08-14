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

// -- Utils Imports --
import { gridTemplate, toColumnDefs, trackGlobalFilter } from "./trackColumns";

// -- Type Imports --
import type { TrackRow as TrackRowData } from "../../types";

// -- Style Imports --
import styles from "./TrackGrid.module.css";

const ROW_HEIGHT = 40;

/**
 * The track grid: TanStack Table holds the sorted and filtered row model over the loaded rows,
 * TanStack Virtual windows the DOM to the visible slice. Sort and search state live here; the
 * search pill and the persistent summary share the toolbar above the header. A row click reports
 * its track up for the detail peek.
 */
export function TrackGrid({
  summary,
  selectedId,
  onSelect,
}: {
  summary?: ReactNode;
  selectedId: number | null;
  onSelect: (track: TrackRowData) => void;
}) {
  const tracks = useTracks();
  const columns = useMemo(() => toColumnDefs(), []);
  const template = useMemo(() => gridTemplate(), []);

  // Sort and search live in the store so a re-scan, which unmounts this grid, keeps them.
  const sorting = useGridSort();
  const globalFilter = useGridFilter();
  const setSorting = useSetGridSort();
  const setGlobalFilter = useSetGridFilter();

  const table = useReactTable({
    data: tracks,
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
            placeholder="Search tracks"
          />
        </div>
        {summary ? <div className={styles.summary}>{summary}</div> : null}
      </div>

      <ScrollArea className={styles.scroll} viewportRef={scrollRef}>
        <TrackGridHeader headers={headers} />
        {noMatch ? (
          <p className={styles.noMatch}>No tracks match "{globalFilter.trim()}"</p>
        ) : (
          <div className={styles.body} style={{ height: virtualizer.getTotalSize() }}>
            {virtualizer.getVirtualItems().map((item) => {
              const track = rows[item.index].original;
              return (
                <TrackRow
                  key={track.id}
                  track={track}
                  active={track.id === selectedId}
                  onSelect={onSelect}
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
