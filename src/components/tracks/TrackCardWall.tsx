// -- Framework Imports --
import { useCallback, useLayoutEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties, RefObject } from "react";

// -- Library Imports --
import { useVirtualizer } from "@tanstack/react-virtual";

// -- Component Imports --
import { GroupHeader } from "./GroupHeader";
import { TrackCard } from "./TrackCard";

// -- Utils Imports --
import { columnCount, flattenCardGroups } from "./trackCardLayout";
import { UNTAGGED_KEY } from "./trackGrouping";

// -- Type Imports --
import type { SelectModifiers } from "./TrackRow";
import type { TrackGroup } from "./trackGrouping";
import type { MenuEntry } from "../common/ContextMenu";
import type { TrackRow as TrackRowData } from "../../types";

// -- i18n Imports --
import { useT } from "../../i18n";

// -- Style Imports --
import styles from "./TrackCardWall.module.css";

// The tile width and gutters mirror the album wall, so both card surfaces reflow on the same grid.
const TILE_WIDTH = 168;
const COL_GAP = 20;
const ROW_GAP = 26;
// Seed heights, corrected once each item measures: a card-row is a tile plus its label block and the
// vertical gutter; a header runs shorter. Only the first paint's layout shift rides on these.
const CARD_ROW_HEIGHT = 254;
const GROUP_HEADER_HEIGHT = 56;

/**
 * The windowed card wall for All Tracks: the cover-wall analogue of the virtualized list. It measures the
 * scroll viewport's content width to fix the column count, chunks the sorted rows into card-rows of that
 * many tiles, and virtualizes vertically over the card-rows, so a wall of tens of thousands of tracks
 * mounts only the visible band. Grouped, it windows a flat header-and-card-row list under collapsible
 * headers, keeping cards honest against a flat wall's repeated covers. The virtualizer scrolls the same
 * viewport the list uses; the canvas padding above the wall becomes the scrollMargin so a card-row's
 * hover lift clears the top edge. Selection, the peek, hover play, and the menu ride through TrackCard
 * unchanged; the parent owns them all.
 */
export function TrackCardWall({
  scrollRef,
  rows,
  grouping,
  groups,
  collapsed,
  onToggleCollapse,
  selectedId,
  selection,
  selecting,
  onOpen,
  onToggleSelect,
  onPlay,
  buildMenu,
}: {
  // The scroll viewport handed down from the grid, so the wall windows the same bespoke surface the list
  // does rather than a nested scroller.
  scrollRef: RefObject<HTMLDivElement | null>;
  // The sorted, filtered rows in flat visual order, chunked into card-rows when ungrouped.
  rows: TrackRowData[];
  grouping: boolean;
  groups: TrackGroup[];
  collapsed: Set<string>;
  onToggleCollapse: (key: string) => void;
  selectedId: number | null;
  selection: Set<number>;
  selecting: boolean;
  onOpen: (track: TrackRowData) => void;
  onToggleSelect: (trackId: number, mods: SelectModifiers) => void;
  onPlay?: (track: TrackRowData) => void;
  buildMenu: (track: TrackRowData) => MenuEntry[];
}) {
  const t = useT();
  const bodyRef = useRef<HTMLDivElement | null>(null);

  // The tiles' own content width drives the column count, so no page padding is folded into the math.
  const [width, setWidth] = useState(0);
  // The wall sits below the canvas top padding; that offset is the virtualizer's scroll margin, so the
  // absolute card-rows land clear of the top edge and their hover lift is not shorn.
  const [scrollMargin, setScrollMargin] = useState(0);

  useLayoutEffect(() => {
    const body = bodyRef.current;
    if (!body) return;
    setWidth(body.clientWidth);
    setScrollMargin(body.offsetTop);
    const observer = new ResizeObserver(() => setWidth(body.clientWidth));
    observer.observe(body);
    return () => observer.disconnect();
  }, []);

  const cols = columnCount(width, TILE_WIDTH, COL_GAP);

  // Grouped, the wall windows a header-and-card-row list; flat, it windows the card-rows alone. Both
  // recompute when the column count changes, since a reflow rechunks every row.
  const items = useMemo(
    () => (grouping ? flattenCardGroups(groups, collapsed, cols) : null),
    [grouping, groups, collapsed, cols],
  );
  const rowCount = grouping ? (items?.length ?? 0) : Math.ceil(rows.length / cols);

  // Key by content, not index: a collapse or a reflow shifts every following index, so a measured height
  // must stay pinned to its card-row (its group key and in-group row index) rather than a raw position.
  const getItemKey = useCallback(
    (index: number) => {
      if (!grouping) return `f:${index}`;
      const item = items?.[index];
      if (!item) return index;
      return item.type === "header" ? `h:${item.group.key}` : `r:${item.groupKey}:${item.row}`;
    },
    [grouping, items],
  );

  const virtualizer = useVirtualizer({
    count: rowCount,
    getScrollElement: () => scrollRef.current,
    estimateSize: (index) =>
      grouping && items?.[index]?.type === "header" ? GROUP_HEADER_HEIGHT : CARD_ROW_HEIGHT,
    getItemKey,
    scrollMargin,
    overscan: 4,
  });

  const rowStyle: CSSProperties = { gap: `0 ${COL_GAP}px`, paddingBottom: ROW_GAP };

  const renderCards = (tracks: TrackRowData[]) =>
    tracks.map((track) => (
      <TrackCard
        key={track.id}
        track={track}
        active={track.id === selectedId}
        checked={selection.has(track.id)}
        selecting={selecting}
        onOpen={onOpen}
        onToggleSelect={onToggleSelect}
        onPlay={onPlay}
        buildMenu={buildMenu}
      />
    ));

  return (
    <div ref={bodyRef} className={styles.body} style={{ height: virtualizer.getTotalSize() }}>
      {virtualizer.getVirtualItems().map((item) => {
        const y: CSSProperties = { transform: `translateY(${item.start - scrollMargin}px)` };

        if (grouping) {
          const entry = items?.[item.index];
          if (!entry) return null;
          if (entry.type === "header") {
            const group = entry.group;
            return (
              <GroupHeader
                key={`h:${group.key}`}
                index={item.index}
                measureRef={virtualizer.measureElement}
                style={y}
                label={group.key === UNTAGGED_KEY ? t((d) => d.tracks.untagged) : group.label}
                count={group.rows.length}
                collapsed={collapsed.has(group.key)}
                first={item.index === 0}
                onToggle={() => onToggleCollapse(group.key)}
              />
            );
          }
          return (
            <div
              key={`r:${entry.groupKey}:${entry.row}`}
              className={styles.cardRow}
              data-index={item.index}
              ref={virtualizer.measureElement}
              style={{ ...y, ...rowStyle }}
            >
              {renderCards(entry.tracks)}
            </div>
          );
        }

        const slice = rows.slice(item.index * cols, item.index * cols + cols);
        return (
          <div
            key={`f:${item.index}`}
            className={styles.cardRow}
            data-index={item.index}
            ref={virtualizer.measureElement}
            style={{ ...y, ...rowStyle }}
          >
            {renderCards(slice)}
          </div>
        );
      })}
    </div>
  );
}
