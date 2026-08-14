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
  arrayMove,
  sortableKeyboardCoordinates,
  verticalListSortingStrategy,
} from "@dnd-kit/sortable";

// -- Component Imports --
import { AlbumTrackRow } from "./AlbumTrackRow";

// -- State Imports --
import { useAlbumTracks, useReorderTracks } from "../../state/organize/store";

// -- i18n Imports --
import { useT } from "../../i18n";

// -- Style Imports --
import styles from "./AlbumTrackList.module.css";

/**
 * The album's tracks in order, sortable by drag. Empty is offered plainly - an album can hold no tracks
 * (delete or keep). Each row carries a dedicated grip handle; the title field stays independently editable
 * because the drag listeners live on the handle, not the row. Dropping rewrites the numbering in the store,
 * and the list re-sorts into place.
 */
export function AlbumTrackList({ albumId }: { albumId: number }) {
  const tracks = useAlbumTracks(albumId);
  const reorder = useReorderTracks();
  const t = useT();

  // A few px of travel arms a drag, so a click that lands on the handle before pressing the title edits
  // rather than jitters into a reorder. Keyboard sensor drives the accessible reorder.
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  if (tracks.length === 0) {
    return <p className={styles.empty}>{t((d) => d.albums.noTracks)}</p>;
  }

  const ids = tracks.map((row) => row.track_id);

  const onDragEnd = ({ active, over }: DragEndEvent) => {
    // A drop outside any row, or back onto the source, leaves the order untouched.
    if (!over || over.id === active.id) return;
    const from = ids.indexOf(Number(active.id));
    const to = ids.indexOf(Number(over.id));
    if (from === -1 || to === -1) return;
    reorder(albumId, arrayMove(ids, from, to));
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
          {tracks.map((row) => (
            <AlbumTrackRow key={row.track_id} row={row} />
          ))}
        </div>
      </SortableContext>
    </DndContext>
  );
}
