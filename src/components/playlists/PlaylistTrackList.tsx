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

// -- Component Imports --
import { PlaylistTrackRow } from "./PlaylistTrackRow";

// -- State Imports --
import {
  usePlaylistTracks,
  useRemovePlaylistSlots,
  useReorderPlaylist,
} from "../../state/playlists/store";

// -- Utils Imports --
import { reorderSlots } from "./playlistOrder";

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
  const t = useT();

  // A few px of travel arms a drag, so a click that lands on the handle before pressing the row opens
  // the peek rather than jittering into a reorder. Keyboard sensor drives the accessible reorder.
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  const ids = useMemo(() => tracks.map((slot) => slot.id), [tracks]);

  if (tracks.length === 0) {
    return <p className={styles.empty}>{t((d) => d.playlists.noTracks)}</p>;
  }

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
            />
          ))}
        </div>
      </SortableContext>
    </DndContext>
  );
}
