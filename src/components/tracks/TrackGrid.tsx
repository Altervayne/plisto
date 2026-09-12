// -- Framework Imports --
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import type { CSSProperties, ReactNode } from "react";

// -- Library Imports --
import {
  getCoreRowModel,
  getFilteredRowModel,
  getSortedRowModel,
  useReactTable,
} from "@tanstack/react-table";
import { useVirtualizer } from "@tanstack/react-virtual";

// -- Icon Imports --
import { ArrowUpToLine, ChevronsDownUp, ChevronsUpDown, Crop, Disc, Disc3, FolderOpen, Info, ListEnd, ListPlus, Play, Scissors } from "lucide-react";

// -- Component Imports --
import { ScrollArea } from "../common/ScrollArea/ScrollArea";
import { SearchField } from "../common/SearchField";
import { EmptyState } from "../common/EmptyState";
import { QuietButton } from "../common/QuietButton";
import { FacetFilter } from "./FacetFilter";
import { GroupByControl } from "./GroupByControl";
import { GroupHeader } from "./GroupHeader";
import { TrackGridHeader } from "./TrackGridHeader";
import { TrackRow } from "./TrackRow";
import { TrackCard } from "./TrackCard";
import { AlbumPicker } from "../organize/AlbumPicker";
import { PlaylistPicker } from "../playlists/PlaylistPicker";

// -- State Imports --
import { useEditTrack, useTracks } from "../../state/store";
import {
  useAddSelection,
  useAlbums,
  useAssignTracks,
  useCreateSingle,
  useGenres,
  useRemoveSelection,
  useSelectRange,
  useSelection,
  useToggleSelect,
} from "../../state/organize/store";
import {
  useAddTracksToPlaylist,
  useCreatePlaylist,
  usePlaylists,
} from "../../state/playlists/store";
import { usePlayerActions, usePlayerEnabled } from "../../state/player/store";
import { useSetOpenTool } from "../../state/shell/store";

// -- Utils Imports --
import { gridTemplate, toColumnDefs, trackColumns, trackGlobalFilter } from "./trackColumns";
import { filterByFacets } from "./trackFacets";
import { UNTAGGED_KEY, flattenGroups, groupRows } from "./trackGrouping";
import { revealFile } from "../../lib/opener";
import { canSplice } from "../../lib/splice";

// -- Type Imports --
import type { SelectModifiers } from "./TrackRow";
import type { TrackColumn } from "./trackColumns";
import type { GridFacet, GroupDimension } from "./trackFacets";
import type { TrackGroup } from "./trackGrouping";
import type { MenuEntry } from "../common/ContextMenu";
import type { FilesViewMode, GridSort } from "../../state/store";
import type { PlaybackSource, TrackEditFields, TrackRow as TrackRowData } from "../../types";

// -- i18n Imports --
import { useT } from "../../i18n";

// -- Style Imports --
import styles from "./TrackGrid.module.css";

const ROW_HEIGHT = 40;
// The seed height for a group header, corrected once the real header measures. It only trims the first
// paint's layout shift, so an approximation is enough.
const GROUP_HEADER_HEIGHT = 56;

// A stable empty chip set, so a plain browser (facets off) never rebuilds the pre-filter each render.
const NO_FACETS: GridFacet[] = [];

// A stable empty group list, so the ungrouped path holds one reference rather than a fresh array.
const NO_GROUPS: TrackGroup[] = [];

/** The filename without its extension: everything before the last dot, or the whole name when it has none. */
function filenameStem(filename: string): string {
  const dot = filename.lastIndexOf(".");
  return dot > 0 ? filename.slice(0, dot) : filename;
}

/**
 * The track grid: TanStack Table holds the sorted and filtered row model over the loaded rows,
 * TanStack Virtual windows the DOM to the visible slice. Sort, search, and the facet chips are
 * controlled by the caller, so each destination owns its own filter set and they never leak across.
 * The search pill and the persistent summary share the toolbar above the header. A row click reports
 * its track up for the detail peek. A `tracks` list scopes the grid to a subset (a folder view);
 * without it the grid spans the whole index. `columns` picks the visible column set; `enableFacets`
 * drops the facet filter for a plain browser; `source` tags what the queue plays from. Passing
 * `onGroupByChange` arms the group-by control and the collapsible section headers; without it the body
 * stays flat. `onVisibleCount` reports the unique filtered row count so a caller's header stays honest.
 */
export function TrackGrid({
  tracks,
  summary,
  view = "table",
  columns = trackColumns,
  enableFacets = true,
  source = { kind: "files" },
  sort,
  onSortChange,
  search,
  onSearchChange,
  facets = NO_FACETS,
  onFacetsChange,
  groupBy = "none",
  onGroupByChange,
  onVisibleCount,
  selectedId,
  onSelect,
}: {
  tracks?: TrackRowData[];
  summary?: ReactNode;
  // How the body draws. Cards only fit the flat file list, so the caller passes it only there.
  view?: FilesViewMode;
  columns?: TrackColumn[];
  enableFacets?: boolean;
  source?: PlaybackSource;
  sort: GridSort;
  onSortChange: (sort: GridSort) => void;
  search: string;
  onSearchChange: (search: string) => void;
  facets?: GridFacet[];
  onFacetsChange?: (facets: GridFacet[]) => void;
  groupBy?: GroupDimension;
  onGroupByChange?: (groupBy: GroupDimension) => void;
  onVisibleCount?: (count: number) => void;
  selectedId: number | null;
  onSelect: (track: TrackRowData) => void;
}) {
  const allTracks = useTracks();
  const t = useT();
  const scoped = tracks ?? allTracks;
  const columnDefs = useMemo(() => toColumnDefs(columns), [columns]);
  const template = useMemo(() => gridTemplate(columns), [columns]);

  const sorting = sort;
  const globalFilter = search;
  const setSorting = onSortChange;
  const setGlobalFilter = onSearchChange;
  // A plain browser drops the facet control, so its chips are always empty and the pre-filter is a no-op.
  const activeFacets = enableFacets ? facets : NO_FACETS;

  // Genre facets read the per-track vocabulary membership, so resolve ids to names through the vocabulary.
  const genres = useGenres();
  const genreNameById = useMemo(
    () => new Map(genres.map((g) => [g.id, g.name] as const)),
    [genres],
  );

  // The chip facets pre-filter the rows client-side; the table then runs the free-text search and sort
  // over what is left, so all three compose and both the table and the card wall read the same rows.
  const data = useMemo(
    () => filterByFacets(scoped, activeFacets, genreNameById),
    [scoped, activeFacets, genreNameById],
  );

  const table = useReactTable({
    data,
    columns: columnDefs,
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

  // Report the unique filtered row count (the sorted row model, before any genre duplication), so a
  // caller's header reflects the narrowed view rather than the whole library.
  useEffect(() => {
    onVisibleCount?.(rows.length);
  }, [rows.length, onVisibleCount]);

  // Grouping is the last presentational pass, folding the already-sorted rows under section headers. It
  // arms only when the caller wired the control and picked a dimension; otherwise the body stays flat.
  const grouping = onGroupByChange != null && groupBy !== "none";
  const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
  // A dimension change retires the old keys, so start each dimension fully expanded.
  useEffect(() => {
    setCollapsed(new Set());
  }, [groupBy]);

  const groups = useMemo(() => {
    // grouping narrows groupBy to a real dimension, so the "none" default never reaches groupRows.
    if (!grouping) return NO_GROUPS;
    return groupRows(
      rows.map((r) => r.original),
      groupBy,
      genreNameById,
    );
  }, [grouping, rows, groupBy, genreNameById]);
  const flat = useMemo(() => flattenGroups(groups, collapsed), [groups, collapsed]);

  const toggleCollapse = (key: string) =>
    setCollapsed((prev) => {
      const next = new Set(prev);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });
  const allCollapsed = groups.length > 0 && groups.every((g) => collapsed.has(g.key));
  const toggleCollapseAll = () =>
    setCollapsed(allCollapsed ? new Set() : new Set(groups.map((g) => g.key)));

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
  // The play queue walks the screen: grouped, it follows the flattened visual order and drops a
  // genre-duplicated track after its first sighting so next and prev never land on it twice; flat, it is
  // the plain row order. Collapsed groups contribute nothing, since their rows are off screen.
  const queueIds = useMemo(() => {
    if (!grouping) return rows.map((r) => r.original.id);
    const ids: number[] = [];
    const seen = new Set<number>();
    for (const item of flat) {
      if (item.type !== "row" || seen.has(item.track.id)) continue;
      seen.add(item.track.id);
      ids.push(item.track.id);
    }
    return ids;
  }, [grouping, rows, flat]);
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

  // The right-click menu acts on the one row it opened over, never the multi-selection: each entry
  // targets that track alone. The two "Add to..." pickers hold that track id while open, so choosing
  // lands on it even after the menu has closed.
  const { play, addToQueue } = usePlayerActions();
  const playerEnabled = usePlayerEnabled();
  const albums = useAlbums();
  const assignTracks = useAssignTracks();
  const createSingle = useCreateSingle();
  const editTrack = useEditTrack();
  const playlists = usePlaylists();
  const addTracksToPlaylist = useAddTracksToPlaylist();
  const createPlaylist = useCreatePlaylist();
  const setOpenTool = useSetOpenTool();
  const [albumPickerTrack, setAlbumPickerTrack] = useState<number | null>(null);
  const [playlistPickerTrack, setPlaylistPickerTrack] = useState<number | null>(null);

  // Seeds the title from the filename stem through the track's own edit path, the same write the peek
  // makes, so it reflects at once and reverts like any typed title.
  const useFilenameAsTitle = (track: TrackRowData) => {
    const edits: TrackEditFields = {
      title: track.title_edit,
      artist: track.artist_edit,
      album: track.album_edit,
      album_artist: track.album_artist_edit,
      year: track.year_edit,
      disc_no: track.disc_edit,
    };
    void editTrack(track.id, { ...edits, title: filenameStem(track.filename) });
  };

  // Play is the keyboard and assistive route the hover triangle cannot be: it queues the whole view,
  // cursor on this track. A gone source greys it out with the reason.
  const buildMenu = (track: TrackRowData): MenuEntry[] => {
    // Split and Trim are gated on a container the cutter can slice; a format it cannot greys them out
    // with the reason.
    const spliceable = canSplice(track.ext);
    const spliceTip = spliceable ? undefined : t((d) => d.splice.unsupported);
    return [
      // Play leads the menu only while the player is on; off, the whole scattered play surface goes quiet.
      ...(playerEnabled
        ? [
            {
              icon: <Play size={16} strokeWidth={1.8} />,
              label: t((d) => d.player.play),
              onSelect: () => play(queueIds, queueIds.indexOf(track.id), source),
              disabled: track.missing_at != null,
              tooltip: track.missing_at != null ? t((d) => d.player.fileMissing) : undefined,
            } satisfies MenuEntry,
            {
              icon: <ListEnd size={16} strokeWidth={1.8} />,
              label: t((d) => d.player.addToQueue),
              onSelect: () => addToQueue([track.id], source),
              disabled: track.missing_at != null,
              tooltip: track.missing_at != null ? t((d) => d.player.fileMissing) : undefined,
            } satisfies MenuEntry,
          ]
        : []),
      {
        icon: <FolderOpen size={16} strokeWidth={1.8} />,
        label: t((d) => d.tracks.goToFile),
        onSelect: () => void revealFile(track.source_path),
      },
      {
        icon: <Info size={16} strokeWidth={1.8} />,
        label: t((d) => d.tracks.details),
        onSelect: () => onSelect(track),
      },
      {
        icon: <Scissors size={16} strokeWidth={1.8} />,
        label: t((d) => d.splice.split),
        onSelect: () => setOpenTool({ verb: "split", trackId: track.id }),
        disabled: !spliceable,
        tooltip: spliceTip,
      },
      {
        icon: <Crop size={16} strokeWidth={1.8} />,
        label: t((d) => d.splice.trim),
        onSelect: () => setOpenTool({ verb: "trim", trackId: track.id }),
        disabled: !spliceable,
        tooltip: spliceTip,
      },
      {
        icon: <ArrowUpToLine size={16} strokeWidth={1.8} />,
        label: t((d) => d.tracks.useFilenameAsTitle),
        onSelect: () => useFilenameAsTitle(track),
      },
      { separator: true },
      {
        icon: <Disc size={16} strokeWidth={1.8} />,
        label: t((d) => d.selection.addToAlbum),
        onSelect: () => setAlbumPickerTrack(track.id),
      },
      {
        icon: <ListPlus size={16} strokeWidth={1.8} />,
        label: t((d) => d.playlists.addTo),
        onSelect: () => setPlaylistPickerTrack(track.id),
      },
      {
        icon: <Disc3 size={16} strokeWidth={1.8} />,
        label: t((d) => d.singles.make, { n: 1 }),
        onSelect: () => void createSingle(track.id),
      },
    ];
  };

  // The ScrollArea hands its viewport here, so the virtualizer scrolls the bespoke surface. Grouped, it
  // windows the flattened header-and-row list; flat, the plain rows. Keying by content, not index, keeps
  // a measured header height pinned to its group as a collapse shifts every following index.
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const getItemKey = useCallback(
    (index: number) => {
      if (!grouping) return rows[index]?.original.id ?? index;
      const item = flat[index];
      if (!item) return index;
      return item.type === "header" ? `h:${item.group.key}` : `r:${item.groupKey}:${item.track.id}`;
    },
    [grouping, rows, flat],
  );
  const virtualizer = useVirtualizer({
    count: grouping ? flat.length : rows.length,
    getScrollElement: () => scrollRef.current,
    // A header runs taller than a row; its exact height is measured, so this is only the seed estimate.
    estimateSize: (index) =>
      grouping && flat[index]?.type === "header" ? GROUP_HEADER_HEIGHT : ROW_HEIGHT,
    getItemKey,
    overscan: 8,
  });

  const headers = table.getHeaderGroups()[0]?.headers ?? [];
  const cards = view === "cards";
  const searching = globalFilter.trim().length > 0;
  const noMatch = rows.length === 0 && (searching || activeFacets.length > 0);
  const onPlayRow = playerEnabled
    ? (played: TrackRowData) => play(queueIds, queueIds.indexOf(played.id), source)
    : undefined;
  // Loosen a filter that matched nothing: clear the search and any facet chips back to the full view.
  const clearFilters = () => {
    setGlobalFilter("");
    onFacetsChange?.([]);
  };

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
        {onGroupByChange ? (
          <div className={styles.controls}>
            {enableFacets && onFacetsChange ? (
              <FacetFilter
                tracks={scoped}
                genreNameById={genreNameById}
                facets={facets}
                onChange={onFacetsChange}
              />
            ) : null}
            <GroupByControl groupBy={groupBy} onChange={onGroupByChange} />
            {grouping ? (
              <button
                type="button"
                className={styles.collapseAll}
                aria-label={
                  allCollapsed ? t((d) => d.tracks.expandAll) : t((d) => d.tracks.collapseAll)
                }
                onClick={toggleCollapseAll}
              >
                {allCollapsed ? (
                  <ChevronsUpDown size={15} strokeWidth={1.8} aria-hidden="true" />
                ) : (
                  <ChevronsDownUp size={15} strokeWidth={1.8} aria-hidden="true" />
                )}
              </button>
            ) : null}
          </div>
        ) : enableFacets && onFacetsChange ? (
          <div className={styles.filter}>
            <FacetFilter
              tracks={scoped}
              genreNameById={genreNameById}
              facets={facets}
              onChange={onFacetsChange}
            />
          </div>
        ) : null}
        {summary ? <div className={styles.summary}>{summary}</div> : null}
      </div>

      {cards ? null : (
        <TrackGridHeader
          headers={headers}
          columns={columns}
          selectAll={selectAll}
          onToggleAll={onToggleAll}
        />
      )}

      <ScrollArea
        className={styles.scroll}
        contentClassName={cards ? styles.canvas : styles.scrollInner}
        viewportRef={scrollRef}
      >
        {noMatch ? (
          <EmptyState
            tone="idle"
            title={t((d) => d.tracks.noMatchTitle)}
            line={
              searching
                ? t((d) => d.tracks.noMatch, { q: globalFilter.trim() })
                : t((d) => d.tracks.noFilterMatch)
            }
            action={
              <QuietButton onClick={clearFilters}>{t((d) => d.tracks.clearFilters)}</QuietButton>
            }
          />
        ) : cards ? (
          <div className={styles.cards}>
            {rows.map((row) => {
              const track = row.original;
              return (
                <TrackCard
                  key={track.id}
                  track={track}
                  active={track.id === selectedId}
                  checked={selection.has(track.id)}
                  selecting={selecting}
                  onOpen={onSelect}
                  onToggleSelect={handleToggle}
                  onPlay={onPlayRow}
                  buildMenu={buildMenu}
                />
              );
            })}
          </div>
        ) : grouping ? (
          <div className={styles.body} style={{ height: virtualizer.getTotalSize() }}>
            {virtualizer.getVirtualItems().map((item) => {
              const entry = flat[item.index];
              if (!entry) return null;
              const y: CSSProperties = { transform: `translateY(${item.start}px)` };
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
                    onToggle={() => toggleCollapse(group.key)}
                  />
                );
              }
              const track = entry.track;
              return (
                <TrackRow
                  key={`r:${entry.groupKey}:${track.id}`}
                  track={track}
                  columns={columns}
                  active={track.id === selectedId}
                  selected={selection.has(track.id)}
                  selecting={selecting}
                  onSelect={onSelect}
                  onToggle={handleToggle}
                  onPlay={onPlayRow}
                  buildMenu={buildMenu}
                  style={y}
                />
              );
            })}
          </div>
        ) : (
          <div className={styles.body} style={{ height: virtualizer.getTotalSize() }}>
            {virtualizer.getVirtualItems().map((item) => {
              const track = rows[item.index].original;
              return (
                <TrackRow
                  key={track.id}
                  track={track}
                  columns={columns}
                  active={track.id === selectedId}
                  selected={selection.has(track.id)}
                  selecting={selecting}
                  onSelect={onSelect}
                  onToggle={handleToggle}
                  onPlay={onPlayRow}
                  buildMenu={buildMenu}
                  style={{ transform: `translateY(${item.start}px)` }}
                />
              );
            })}
          </div>
        )}
      </ScrollArea>

      {albumPickerTrack != null ? (
        <AlbumPicker
          albums={albums}
          onChoose={(albumId) => {
            assignTracks(albumId, [albumPickerTrack]);
            setAlbumPickerTrack(null);
          }}
          onClose={() => setAlbumPickerTrack(null)}
        />
      ) : null}

      {playlistPickerTrack != null ? (
        <PlaylistPicker
          playlists={playlists}
          onChoose={(playlistId) => {
            void addTracksToPlaylist(playlistId, [playlistPickerTrack]);
            setPlaylistPickerTrack(null);
          }}
          onCreate={(name) => {
            const trackId = playlistPickerTrack;
            void (async () => {
              const playlistId = await createPlaylist(name);
              await addTracksToPlaylist(playlistId, [trackId]);
            })();
            setPlaylistPickerTrack(null);
          }}
          onClose={() => setPlaylistPickerTrack(null)}
        />
      ) : null}
    </div>
  );
}
