// -- Framework Imports --
import { useEffect, useMemo, useState } from "react";

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

// -- Component Imports --
import { AlbumTrackRow } from "./AlbumTrackRow";

// -- State Imports --
import { useAlbumTracks, useSetAlbumLayout } from "../../state/organize/store";

// -- Utils Imports --
import { groupByDisc, moveToDisc, placeAt, reorderOnto } from "./albumLayout";

// -- Type Imports --
import type { AlbumTrackRow as AlbumTrackRowData } from "../../types";

// -- i18n Imports --
import { useT } from "../../i18n";

// -- Style Imports --
import styles from "./AlbumTrackList.module.css";

/** The droppable id an empty disc zone carries, its disc number trailing so a drop can read it back. */
const EMPTY_DISC = "empty-disc-";

/**
 * The album's tracks in the drawer, grouped by disc and sortable by drag across the whole set. A
 * single-disc album (every track on disc 1, an unset disc counting as one) renders as one bare list,
 * no separators - pristine. Spanning more than one disc parts the list into "Disc n" groups, each
 * numbered 1..n on its own. One context spans every disc, so a drag crosses disc lines: the drop
 * resolves its target disc and the index within it from live geometry, then recomputes the full
 * atomic layout so the stored track_no is always the per-disc position. A quiet foot reveals an empty
 * disc as a drop target; nothing persists until a track lands there.
 */
export function AlbumTrackList({ albumId }: { albumId: number }) {
  const tracks = useAlbumTracks(albumId);
  const setLayout = useSetAlbumLayout();
  const t = useT();

  // A revealed-but-empty extra disc, held here alone: it is only a drop zone, never persisted, so it
  // drops away when the drawer moves to another album.
  const [addedDisc, setAddedDisc] = useState<number | null>(null);
  useEffect(() => setAddedDisc(null), [albumId]);

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

  return (
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
                  <DiscRows rows={g.rows} showDisc onSetDisc={onSetDisc} />
                )}
              </div>
            ))}
          </div>
        ) : (
          <DiscRows rows={displayGroups[0].rows} showDisc={false} onSetDisc={onSetDisc} />
        )}
      </SortableContext>

      <div className={styles.foot}>
        <button type="button" className={styles.addDisc} onClick={addDisc}>
          {t((d) => d.albums.addDisc)}
        </button>
      </div>
    </DndContext>
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
}: {
  rows: AlbumTrackRowData[];
  showDisc: boolean;
  onSetDisc: (trackId: number, disc: number | null) => void;
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
