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
import { Play, X } from "lucide-react";

// -- Component Imports --
import { PlaylistTrackRow } from "./PlaylistTrackRow";

// -- State Imports --
import {
  usePlaylistTracks,
  useRemovePlaylistSlots,
  useReorderPlaylist,
} from "../../state/playlists/store";
import { usePlayerActions } from "../../state/player/store";

// -- Utils Imports --
import { reorderSlots } from "./playlistOrder";

// -- Type Imports --
import type { MenuEntry } from "../common/ContextMenu";

// -- i18n Imports --
import { useT } from "../../i18n";

// -- Style Imports --
import styles from "./PlaylistTrackList.module.css";

/**
 * The playlist's slots as one flat sortable list, keyed by slot id - a repeated track carries a distinct
 * slot, so each copy reorders and removes on its own. One context spans the whole list; a drop resolves
 * against live row geometry, then the store optimistically renumbers positions so the drag never
 * flickers. Passing `onOpenSlot` puts the rows in browse mode: a row click opens the track peek, and
 * `openSlotId` marks the peeked one.
 */
export function PlaylistTrackList({
  playlistId,
  onOpenSlot,
  openSlotId,
}: {
  playlistId: number;
  onOpenSlot: (slotId: number) => void;
  openSlotId: number | null;
}) {
  const tracks = usePlaylistTracks(playlistId);
  const reorder = useReorderPlaylist();
  const removeSlots = useRemovePlaylistSlots();
  const { play } = usePlayerActions();
  const t = useT();

  // A few px of travel arms a drag, so a click that lands on the handle before pressing the row opens
  // the peek rather than jittering into a reorder. Keyboard sensor drives the accessible reorder.
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  const ids = useMemo(() => tracks.map((slot) => slot.id), [tracks]);
  // The queue reads track ids, not slot ids: a repeated track legitimately appears twice, so the cursor
  // resolves by the slot's own index, computed at the call site below.
  const trackIds = useMemo(() => tracks.map((slot) => slot.track_id), [tracks]);

  if (tracks.length === 0) {
    return <p className={styles.empty}>{t((d) => d.playlists.noTracks)}</p>;
  }

  // The row's right-click menu: Play (the keyboard route the hover triangle cannot be) over Remove.
  // A gone source or an undecodable format greys Play out with the reason.
  const buildMenu = (slot: (typeof tracks)[number], index: number): MenuEntry[] => {
    const unplayable = slot.missing_at != null || slot.filename.toLowerCase().endsWith(".opus");
    return [
      {
        icon: <Play size={16} strokeWidth={1.8} />,
        label: t((d) => d.player.play),
        onSelect: () => play(trackIds, index),
        disabled: unplayable,
        tooltip: unplayable
          ? slot.missing_at != null
            ? t((d) => d.player.fileMissing)
            : t((d) => d.player.unsupportedFormat)
          : undefined,
      },
      {
        icon: <X size={16} strokeWidth={1.8} />,
        label: t((d) => d.playlists.removeTrack),
        style: "destructive",
        onSelect: () => void removeSlots([slot.id]),
      },
    ];
  };

  const onDragEnd = ({ active, over }: DragEndEvent) => {
    // A drop outside any target, or back onto the source, leaves the order untouched.
    if (!over || over.id === active.id) return;
    const movedId = Number(active.id);
    const overId = Number(over.id);
    if (!tracks.some((slot) => slot.id === overId)) return;
    reorder(playlistId, reorderSlots(ids, movedId, overId));
  };

  return (
    <DndContext
      sensors={sensors}
      // Resolve drops against live row geometry, never a drag-start snapshot: an optimistic reorder
      // renumbers and remounts the rows mid-interaction.
      measuring={{ droppable: { strategy: MeasuringStrategy.Always } }}
      onDragEnd={onDragEnd}
    >
      <SortableContext items={ids} strategy={verticalListSortingStrategy}>
        <div className={styles.list}>
          {tracks.map((slot, i) => (
            <PlaylistTrackRow
              key={slot.id}
              slot={slot}
              displayNo={i + 1}
              peeked={slot.id === openSlotId}
              onOpen={() => onOpenSlot(slot.id)}
              onRemove={() => void removeSlots([slot.id])}
              onPlay={() => play(trackIds, i)}
              buildMenu={() => buildMenu(slot, i)}
            />
          ))}
        </div>
      </SortableContext>
    </DndContext>
  );
}
