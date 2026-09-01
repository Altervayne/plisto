// -- Framework Imports --
import { useEffect, useMemo, useRef, useState } from "react";

// -- Library Imports --
import {
  DndContext,
  KeyboardSensor,
  MeasuringStrategy,
  PointerSensor,
  useDroppable,
  useSensor,
  useSensors,
  type DragEndEvent,
} from "@dnd-kit/core";
import {
  SortableContext,
  sortableKeyboardCoordinates,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";

// -- Icon Imports --
import { FolderOpen, Image as ImageIcon, Info, ListPlus, Play, X } from "lucide-react";

// -- Component Imports --
import { AlbumSelectionBar } from "./AlbumSelectionBar";
import { AlbumTrackRow } from "./AlbumTrackRow";
import { PlaylistPicker } from "../playlists/PlaylistPicker";
import { ExtractPanel } from "../extract/ExtractPanel";

// -- State Imports --
import { useAppStore } from "../../state/store";
import {
  useAlbumTracks,
  useLoadOrganization,
  useResetHistory,
  useSetAlbumLayout,
  useSetTrackKeepOwnCover,
  useUnassignTracks,
} from "../../state/organize/store";
import {
  useAddTracksToPlaylist,
  useCreatePlaylist,
  usePlaylists,
} from "../../state/playlists/store";
import { usePlayerActions, usePlayerEnabled } from "../../state/player/store";

// -- Hook Imports --
import { useMountTransition } from "../../hooks/useMountTransition";

// -- Utils Imports --
import { groupByDisc, moveManyToDisc, moveToDisc, placeAt, reorderOnto } from "./albumLayout";
import { revealFile } from "../../lib/opener";
import { importTrackCover } from "../../lib/ipc";
import { pickImageFile } from "../../lib/dialog";

// -- Type Imports --
import type { MenuEntry } from "../common/ContextMenu";
import type { AlbumTrackRow as AlbumTrackRowData } from "../../types";
import type { ExtractTrack } from "../extract/ExtractPanel";

// -- i18n Imports --
import { useT } from "../../i18n";

// -- Style Imports --
import styles from "./AlbumTrackList.module.css";

/** The droppable id an empty disc zone carries, its disc number trailing so a drop can read it back. */
const EMPTY_DISC = "empty-disc-";

/** The selection bar's exit before it unmounts, matching --dur-fast on the exit keyframe. */
const BAR_EXIT_MS = 120;

/**
 * The album's tracks in the drawer, grouped by disc and sortable by drag across the whole set. A
 * single-disc album (every track on disc 1, an unset disc counting as one) renders as one bare list,
 * no separators - pristine. Spanning more than one disc parts the list into "Disc n" groups, each
 * numbered 1..n on its own. One context spans every disc, so a drag crosses disc lines: the drop
 * resolves its target disc and the index within it from live geometry, then recomputes the full
 * atomic layout so the stored track_no is always the per-disc position. A quiet foot reveals an empty
 * disc as a drop target; nothing persists until a track lands there. The same list serves the full-pane
 * view: passing `onOpenTrack` puts the rows in browse mode, and `openTrackId` marks the peeked one.
 */
export function AlbumTrackList({
  albumId,
  onOpenTrack,
  openTrackId,
}: {
  albumId: number;
  onOpenTrack?: (trackId: number) => void;
  openTrackId?: number | null;
}) {
  const tracks = useAlbumTracks(albumId);
  const setLayout = useSetAlbumLayout();
  const unassignTracks = useUnassignTracks();
  const setTrackKeepOwnCover = useSetTrackKeepOwnCover();
  const loadOrganization = useLoadOrganization();
  const resetHistory = useResetHistory();
  const playlists = usePlaylists();
  const createPlaylist = useCreatePlaylist();
  const addTracksToPlaylist = useAddTracksToPlaylist();
  const { play } = usePlayerActions();
  const playerEnabled = usePlayerEnabled();
  const t = useT();

  // The extractor opens over a snapshot of the selection, so a later selection clear leaves it intact.
  const [extractTracks, setExtractTracks] = useState<ExtractTrack[] | null>(null);
  // The playlist picker serves two openers: the selection bar (a snapshot of the whole selection, which
  // clears once added) and a row's right-click menu (that one track, which leaves the selection alone).
  // `fromSelection` remembers which, so only the bar's flow clears the selection after.
  const [playlistPicker, setPlaylistPicker] = useState<{
    tracks: number[];
    fromSelection: boolean;
  } | null>(null);

  // A revealed-but-empty extra disc, held here alone: it is only a drop zone, never persisted, so it
  // drops away when the drawer moves to another album.
  const [addedDisc, setAddedDisc] = useState<number | null>(null);

  // The track selection is scoped to this album alone, kept off the global selection slice, and reset
  // whenever the drawer moves on. The anchor holds the last click's index in visual order for a range.
  const [selected, setSelected] = useState<Set<number>>(() => new Set());
  const anchorRef = useRef<number | null>(null);
  useEffect(() => {
    setAddedDisc(null);
    setSelected(new Set());
    anchorRef.current = null;
  }, [albumId]);

  // Hold the header bar through its exit after the selection clears, so it fades out rather than blinking.
  const selectionBar = useMountTransition(selected.size > 0, BAR_EXIT_MS);

  // A few px of travel arms a drag, so a click that lands on the handle before pressing the title edits
  // rather than jitters into a reorder. Keyboard sensor drives the accessible reorder across discs.
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  const groups = useMemo(() => groupByDisc(tracks), [tracks]);

  // The rendered groups: the real discs plus, when revealed and not already real, one empty target disc.
  const displayGroups = useMemo(() => {
    if (addedDisc == null || groups.some((g) => g.disc === addedDisc)) return groups;
    return [...groups, { disc: addedDisc, rows: [] as AlbumTrackRowData[] }];
  }, [groups, addedDisc]);

  // Every row id in visual order feeds the one spanning context, so a reorder shifts and settles across
  // disc lines as a single list.
  const ids = useMemo(
    () => displayGroups.flatMap((g) => g.rows.map((r) => r.track_id)),
    [displayGroups],
  );

  if (tracks.length === 0) {
    return <p className={styles.empty}>{t((d) => d.albums.noTracks)}</p>;
  }

  // Reveal an empty disc one past the highest real one; a still-open empty disc keeps the same number.
  const addDisc = () => {
    const highest = groups.length ? groups[groups.length - 1].disc : 1;
    setAddedDisc(highest + 1);
  };

  // A per-row disc field moves one track to the typed disc, appended there, then renumbers every disc.
  const onSetDisc = (trackId: number, disc: number | null) => {
    setLayout(albumId, moveToDisc(tracks, trackId, disc));
  };

  const clearSelection = () => {
    setSelected(new Set());
    anchorRef.current = null;
  };

  // Toggles one track, or, on a shift-click with a live anchor, adds the inclusive visual-order range
  // between the anchor and this track to the current selection. A plain click reseats the anchor.
  const onToggleSelect = (trackId: number, mods: { shift: boolean; meta: boolean }) => {
    const index = ids.indexOf(trackId);
    if (mods.shift && anchorRef.current != null) {
      const anchor = anchorRef.current;
      const [lo, hi] = anchor <= index ? [anchor, index] : [index, anchor];
      setSelected((prev) => {
        const next = new Set(prev);
        for (const id of ids.slice(lo, hi + 1)) next.add(id);
        return next;
      });
      return;
    }
    setSelected((prev) => {
      const next = new Set(prev);
      if (!next.delete(trackId)) next.add(trackId);
      return next;
    });
    anchorRef.current = index;
  };

  const selectAll = () => {
    setSelected(new Set(ids));
    anchorRef.current = null;
  };

  // Lays every selected track onto `disc`, appended there in their current order, then clears.
  const moveSelectedToDisc = (disc: number) => {
    setLayout(albumId, moveManyToDisc(tracks, [...selected], disc));
    clearSelection();
  };

  // The undoable remove-from-album, then clears.
  const removeSelected = () => {
    unassignTracks(albumId, [...selected]);
    clearSelection();
  };

  // Flags every selected membership to keep (or drop) its own cover on export, then clears. A track
  // with no art of its own falls back to the album cover regardless, so the flag is safe to set en masse.
  const setSelectedKeepOwnCover = (value: boolean) => {
    void setTrackKeepOwnCover(albumId, [...selected], value);
    clearSelection();
  };

  // Assigns one picked image as the cover of every selected track, then clears. A per-track cover is
  // resolved backend-side on read, so nothing in the drawer state needs a reload; a cancelled pick is a no-op.
  const setSelectedCover = async () => {
    const ids = [...selected];
    const path = await pickImageFile();
    if (!path) return;
    await importTrackCover(ids, path);
    clearSelection();
  };

  // Adds the picker's target tracks to an existing playlist, then closes. Only the selection-bar flow
  // clears the selection after; a row-menu add leaves it untouched.
  const onChoosePlaylist = (playlistId: number) => {
    if (!playlistPicker) return;
    void addTracksToPlaylist(playlistId, playlistPicker.tracks);
    if (playlistPicker.fromSelection) clearSelection();
    setPlaylistPicker(null);
  };

  // Creates a playlist from the typed name, adds the picker's target tracks to it, then closes.
  const onCreatePlaylist = async (name: string) => {
    if (!playlistPicker) return;
    const { tracks: targets, fromSelection } = playlistPicker;
    const playlistId = await createPlaylist(name);
    await addTracksToPlaylist(playlistId, targets);
    if (fromSelection) clearSelection();
    setPlaylistPicker(null);
  };

  // The row's right-click menu, in album-member context. Details rides only in browse mode, where a
  // peek exists to open. The cover entry flips by the membership's current flag: keeping its own art or
  // falling back to the album cover. Remove-from-album is the sole destructive entry.
  const buildTrackMenu = (row: AlbumTrackRowData): MenuEntry[] => {
    const unplayable = row.missing_at != null;
    const items: MenuEntry[] = [
      // Play leads only while the player is on; off, the whole scattered play surface goes quiet.
      ...(playerEnabled
        ? [
            {
              icon: <Play size={16} strokeWidth={1.8} />,
              label: t((d) => d.player.play),
              onSelect: () => play(ids, ids.indexOf(row.track_id)),
              disabled: unplayable,
              tooltip: unplayable ? t((d) => d.player.fileMissing) : undefined,
            } satisfies MenuEntry,
          ]
        : []),
      {
        icon: <FolderOpen size={16} strokeWidth={1.8} />,
        label: t((d) => d.tracks.goToFile),
        onSelect: () => void revealFile(row.source_path),
      },
    ];
    if (onOpenTrack) {
      items.push({
        icon: <Info size={16} strokeWidth={1.8} />,
        label: t((d) => d.tracks.details),
        onSelect: () => onOpenTrack(row.track_id),
      });
    }
    items.push(
      { separator: true },
      {
        icon: <ListPlus size={16} strokeWidth={1.8} />,
        label: t((d) => d.playlists.addTo),
        onSelect: () => setPlaylistPicker({ tracks: [row.track_id], fromSelection: false }),
      },
      {
        icon: <ImageIcon size={16} strokeWidth={1.8} />,
        label: row.keep_own_cover ? t((d) => d.albums.useAlbumCover) : t((d) => d.albums.keepOwnCover),
        onSelect: () => void setTrackKeepOwnCover(albumId, [row.track_id], !row.keep_own_cover),
      },
      { separator: true },
      {
        icon: <X size={16} strokeWidth={1.8} />,
        label: t((d) => d.albums.removeFromAlbum),
        style: "destructive",
        onSelect: () => unassignTracks(albumId, [row.track_id]),
      },
    );
    return items;
  };

  // Opens the extractor over the current selection. Album rows carry no display_path, so the source
  // path is the one shown on hover.
  const openExtract = () => {
    setExtractTracks(
      tracks
        .filter((r) => selected.has(r.track_id))
        .map((r) => ({ id: r.track_id, filename: r.filename, path: r.source_path })),
    );
  };

  // After a bulk apply, pull the fresh tracks and membership so the new tags show, drop the undo stack
  // (the apply wrote outside the command engine, so a stale inverse must never replay), then clear.
  const onExtractApplied = () => {
    void useAppStore.getState().loadTracks();
    void loadOrganization();
    resetHistory();
    clearSelection();
  };

  const onDragEnd = ({ active, over }: DragEndEvent) => {
    // A drop outside any target, or back onto the source, leaves the layout untouched.
    if (!over || over.id === active.id) return;
    const trackId = Number(active.id);

    // An empty disc zone seeds the track there first and sheds its transient state. Otherwise the
    // drop reorders onto a row: `reorderOnto` takes that row's disc and slots before or after it by
    // the DIRECTION of travel, not a mid-drag pointer read (which drifts by one on an upward move).
    if (typeof over.id === "string" && over.id.startsWith(EMPTY_DISC)) {
      const disc = Number(over.id.slice(EMPTY_DISC.length));
      setLayout(albumId, placeAt(tracks, trackId, disc, 0));
      setAddedDisc(null);
      return;
    }

    const overId = Number(over.id);
    if (!tracks.some((r) => r.track_id === overId)) return;
    setLayout(albumId, reorderOnto(tracks, trackId, overId));
  };

  const multi = displayGroups.length > 1;
  const selecting = selected.size > 0;
  // The next new disc sits one past the highest real disc, mirroring the add-disc foot.
  const nextDisc = (groups.length ? groups[groups.length - 1].disc : 1) + 1;

  return (
    <>
      {selectionBar.mounted ? (
        <AlbumSelectionBar
          count={selected.size}
          discs={groups.map((g) => g.disc)}
          newDisc={nextDisc}
          state={selectionBar.state}
          onSelectAll={selectAll}
          onMoveToDisc={moveSelectedToDisc}
          onExtract={openExtract}
          onAddToPlaylist={() => setPlaylistPicker({ tracks: [...selected], fromSelection: true })}
          onSetCover={() => void setSelectedCover()}
          onKeepOwnCover={() => setSelectedKeepOwnCover(true)}
          onUseAlbumCover={() => setSelectedKeepOwnCover(false)}
          onRemove={removeSelected}
          onClear={clearSelection}
        />
      ) : null}

      {playlistPicker ? (
        <PlaylistPicker
          playlists={playlists}
          onChoose={onChoosePlaylist}
          onCreate={(name) => void onCreatePlaylist(name)}
          onClose={() => setPlaylistPicker(null)}
        />
      ) : null}

      {extractTracks ? (
        <ExtractPanel
          tracks={extractTracks}
          onClose={() => setExtractTracks(null)}
          onApplied={onExtractApplied}
        />
      ) : null}

      <DndContext
        sensors={sensors}
        // Resolve drops against live row geometry, never a drag-start snapshot: an optimistic reorder
        // renumbers and remounts the rows mid-interaction.
        measuring={{ droppable: { strategy: MeasuringStrategy.Always } }}
        onDragEnd={onDragEnd}
      >
        <SortableContext items={ids} strategy={verticalListSortingStrategy}>
          {multi ? (
            <div className={styles.discs}>
              {displayGroups.map((g) => (
                <div key={g.disc}>
                  <div className={styles.discLabel}>
                    <span>{t((d) => d.albums.discLabel, { n: g.disc })}</span>
                    {g.rows.length === 0 ? (
                      <button
                        type="button"
                        className={styles.removeDisc}
                        onClick={() => setAddedDisc(null)}
                      >
                        {t((d) => d.albums.removeDisc)}
                      </button>
                    ) : null}
                  </div>
                  {g.rows.length === 0 ? (
                    <EmptyDisc disc={g.disc} hint={t((d) => d.albums.discEmpty)} />
                  ) : (
                    <DiscRows
                      rows={g.rows}
                      showDisc
                      onSetDisc={onSetDisc}
                      selected={selected}
                      selecting={selecting}
                      onToggleSelect={onToggleSelect}
                      onOpenTrack={onOpenTrack}
                      openTrackId={openTrackId}
                      onPlay={
                        playerEnabled ? (trackId) => play(ids, ids.indexOf(trackId)) : undefined
                      }
                      buildMenu={buildTrackMenu}
                    />
                  )}
                </div>
              ))}
            </div>
          ) : (
            <DiscRows
              rows={displayGroups[0].rows}
              showDisc={false}
              onSetDisc={onSetDisc}
              selected={selected}
              selecting={selecting}
              onToggleSelect={onToggleSelect}
              onOpenTrack={onOpenTrack}
              openTrackId={openTrackId}
              onPlay={playerEnabled ? (trackId) => play(ids, ids.indexOf(trackId)) : undefined}
              buildMenu={buildTrackMenu}
            />
          )}
        </SortableContext>

        <div className={styles.foot}>
          <button type="button" className={styles.addDisc} onClick={addDisc}>
            {t((d) => d.albums.addDisc)}
          </button>
        </div>
      </DndContext>
    </>
  );
}

/**
 * One disc's rows, numbered 1..n by their position here so numbering restarts per disc. Presentational:
 * the parent's single context owns the drag, so these rows sort within and across every disc alike.
 */
function DiscRows({
  rows,
  showDisc,
  onSetDisc,
  selected,
  selecting,
  onToggleSelect,
  onOpenTrack,
  openTrackId,
  onPlay,
  buildMenu,
}: {
  rows: AlbumTrackRowData[];
  showDisc: boolean;
  onSetDisc: (trackId: number, disc: number | null) => void;
  selected: Set<number>;
  selecting: boolean;
  onToggleSelect: (trackId: number, mods: { shift: boolean; meta: boolean }) => void;
  onOpenTrack?: (trackId: number) => void;
  openTrackId?: number | null;
  onPlay?: (trackId: number) => void;
  buildMenu: (row: AlbumTrackRowData) => MenuEntry[];
}) {
  return (
    <div className={styles.list}>
      {rows.map((row, i) => (
        <AlbumTrackRow
          key={row.track_id}
          row={row}
          displayNo={i + 1}
          showDisc={showDisc}
          onSetDisc={(disc) => onSetDisc(row.track_id, disc)}
          selected={selected.has(row.track_id)}
          selecting={selecting}
          peeked={openTrackId != null && row.track_id === openTrackId}
          onToggleSelect={(mods) => onToggleSelect(row.track_id, mods)}
          onOpen={onOpenTrack ? () => onOpenTrack(row.track_id) : undefined}
          onPlay={onPlay ? () => onPlay(row.track_id) : undefined}
          buildMenu={() => buildMenu(row)}
        />
      ))}
    </div>
  );
}

/**
 * The empty target under a revealed disc: a quiet hint line that also is the disc's droppable, so a
 * track dragged onto it lands there first. It warms as the drag hovers, then vanishes once filled.
 */
function EmptyDisc({ disc, hint }: { disc: number; hint: string }) {
  const { setNodeRef, isOver } = useDroppable({ id: `${EMPTY_DISC}${disc}` });
  return (
    <div ref={setNodeRef} className={styles.discEmpty} data-over={isOver ? "" : undefined}>
      {hint}
    </div>
  );
}
