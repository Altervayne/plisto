// -- Framework Imports --
import { useMemo } from "react";

// -- Library Imports --
import {
  DndContext,
  KeyboardSensor,
  MeasuringStrategy,
  PointerSensor,
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
import { ListEnd, ListStart, Play, X } from "lucide-react";

// -- Component Imports --
import { PlaylistTrackRow } from "./PlaylistTrackRow";
import { PlaylistAlbumRow } from "./PlaylistAlbumRow";

// -- State Imports --
import {
  usePlaylist,
  useRemovePlaylistSlots,
  useReorderPlaylist,
  useSetEntryKeepOrder,
  useUnpackAlbumEntry,
} from "../../state/playlists/store";
import { usePlaylistExpansion } from "../../state/playlists/expansion";
import { usePlayerActions, usePlayerEnabled } from "../../state/player/store";
import { announceAfterBlock, unpacked } from "../../state/player/queueToast";

// -- Utils Imports --
import { reorderSlots } from "./playlistOrder";
import { entryQueue } from "./albumEntryPlay";
import { visualizerMenuItem } from "../player/visualizers/contextPicker/visualizerMenuItem";

// -- Type Imports --
import type { MenuEntry } from "../common/ContextMenu";
import type { PlaybackSource, PlaylistTrackRow as PlaylistSlot } from "../../types";

// -- i18n Imports --
import { useT } from "../../i18n";

// -- Style Imports --
import styles from "./PlaylistTrackList.module.css";

/**
 * The playlist's rows as one flat sortable list, track slots and album entries together, keyed by slot id
 * - a repeated track carries a distinct slot, so each copy reorders and removes on its own, and an album
 * entry drags as one item. One context spans the whole list; a drop resolves against live row geometry,
 * then the store optimistically renumbers positions so the drag never flickers. A play starts at the
 * row's index in the expansion, so an album entry's members are in the queue before and after it. Passing
 * `onOpenSlot` puts the track rows in browse mode: a row click opens the track peek, and `openSlotId`
 * marks the peeked one. An album row unfolds instead; the peek is for tracks only.
 */
export function PlaylistTrackList({
  playlistId,
  onOpenSlot,
  openSlotId,
  onOpenAlbum,
}: {
  playlistId: number;
  onOpenSlot: (slotId: number) => void;
  openSlotId: number | null;
  onOpenAlbum: (albumId: number) => void;
}) {
  const { entries, ids: queueIds, blocks, ready } = usePlaylistExpansion(playlistId);
  const playlist = usePlaylist(playlistId);
  const reorder = useReorderPlaylist();
  const removeSlots = useRemovePlaylistSlots();
  const setKeepOrder = useSetEntryKeepOrder();
  const unpack = useUnpackAlbumEntry();
  const { play, addToQueue, playNext } = usePlayerActions();
  const playerEnabled = usePlayerEnabled();
  const t = useT();

  // Every play from this list is tagged with the playlist as its source, for the "playing from" line.
  const source: PlaybackSource = {
    kind: "playlist",
    id: playlistId,
    label: playlist?.name ?? t((d) => d.playlists.untitled),
  };

  // A few px of travel arms a drag, so a click that lands on the handle before pressing the row opens
  // the peek rather than jittering into a reorder. Keyboard sensor drives the accessible reorder.
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  const slotIds = useMemo(() => entries.map((entry) => entry.id), [entries]);

  if (entries.length === 0) {
    return <p className={styles.empty}>{t((d) => d.playlists.noTracks)}</p>;
  }

  // The row's right-click menu: Play (the keyboard route the hover triangle cannot be) over Remove.
  // A gone source greys Play out with the reason. Play rides only while the player is on; Remove is
  // not a play affordance, so it stays either way and the menu never empties.
  const buildMenu = (slot: PlaylistSlot, first: number): MenuEntry[] => {
    const unplayable = slot.missing_at != null;
    // Its own group after the play rows; both ride only while the player is on.
    const visualizerItem = playerEnabled ? visualizerMenuItem({ track: slot.track_id }, t) : null;
    const visualizerGroup: MenuEntry[] = visualizerItem
      ? [{ separator: true as const }, visualizerItem, { separator: true }]
      : [];
    return [
      ...(playerEnabled
        ? [
            {
              icon: <Play size={16} strokeWidth={1.8} />,
              label: t((d) => d.player.play),
              onSelect: () => play(queueIds, first, source, blocks),
              disabled: unplayable || !ready,
              tooltip: unplayable ? t((d) => d.player.fileMissing) : undefined,
            } satisfies MenuEntry,
            {
              icon: <ListStart size={16} strokeWidth={1.8} />,
              label: t((d) => d.player.playNext),
              onSelect: () => announceAfterBlock(playNext([slot.track_id], source)),
              disabled: unplayable,
              tooltip: unplayable ? t((d) => d.player.fileMissing) : undefined,
            } satisfies MenuEntry,
            {
              icon: <ListEnd size={16} strokeWidth={1.8} />,
              label: t((d) => d.player.addToQueue),
              onSelect: () => addToQueue([slot.track_id], source),
              disabled: unplayable,
              tooltip: unplayable ? t((d) => d.player.fileMissing) : undefined,
            } satisfies MenuEntry,
          ]
        : []),
      ...visualizerGroup,
      {
        icon: <X size={16} strokeWidth={1.8} />,
        label: t((d) => d.playlists.removeTrack),
        style: "destructive",
        onSelect: () => void removeSlots([slot.id]).catch(() => {}),
      },
    ];
  };

  const onDragEnd = ({ active, over }: DragEndEvent) => {
    // A drop outside any target, or back onto the source, leaves the order untouched.
    if (!over || over.id === active.id) return;
    const movedId = Number(active.id);
    const overId = Number(over.id);
    if (!slotIds.includes(overId)) return;
    reorder(playlistId, reorderSlots(slotIds, movedId, overId));
  };

  return (
    <DndContext
      sensors={sensors}
      // Resolve drops against live row geometry, never a drag-start snapshot: an optimistic reorder
      // renumbers and remounts the rows mid-interaction.
      measuring={{ droppable: { strategy: MeasuringStrategy.Always } }}
      onDragEnd={onDragEnd}
    >
      <SortableContext items={slotIds} strategy={verticalListSortingStrategy}>
        <div className={styles.list}>
          {entries.map((entry, i) =>
            entry.kind === "track" ? (
              <PlaylistTrackRow
                key={entry.id}
                slot={entry.slot}
                displayNo={i + 1}
                peeked={entry.id === openSlotId}
                onOpen={() => onOpenSlot(entry.id)}
                onRemove={() => void removeSlots([entry.id]).catch(() => {})}
                onPlay={
                  playerEnabled && ready ? () => play(queueIds, entry.first, source, blocks) : undefined
                }
                buildMenu={() => buildMenu(entry.slot, entry.first)}
              />
            ) : (
              <PlaylistAlbumRow
                key={entry.id}
                entry={entry}
                displayNo={i + 1}
                ready={ready}
                playerEnabled={playerEnabled}
                onPlayFrom={(member) => play(queueIds, entry.first + member, source, blocks)}
                onPlayNext={() => {
                  const queue = entryQueue(entry);
                  announceAfterBlock(playNext(queue.ids, source, queue.blocks));
                }}
                onAddToQueue={() => {
                  const queue = entryQueue(entry);
                  addToQueue(queue.ids, source, queue.blocks);
                }}
                onOpenAlbum={() => onOpenAlbum(entry.entry.album_id)}
                onSetKeep={(keep) => void setKeepOrder(entry.id, keep).catch(() => {})}
                onUnpack={() => {
                  const count = entry.members.length;
                  // The pill only follows a write that went through.
                  void unpack(entry.id)
                    .then(() => {
                      if (count > 0) unpacked(count);
                    })
                    .catch(() => {});
                }}
                onRemove={() => void removeSlots([entry.id]).catch(() => {})}
              />
            ),
          )}
        </div>
      </SortableContext>
    </DndContext>
  );
}
