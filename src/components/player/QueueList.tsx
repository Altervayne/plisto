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
import { ScrollArea } from "../common/ScrollArea/ScrollArea";
import { QuietButton } from "../common/QuietButton";
import { QueueRow } from "./QueueRow";
import { SequenceMenu } from "./SequenceMenu";

// -- State Imports --
import {
  usePlayerActions,
  usePlayerQueue,
  usePlayerQueueIndex,
  usePlayerQueueMeta,
} from "../../state/player/store";

// -- Format Imports --
import { formatCount } from "../../lib/format";

// -- Local Imports --
import { queueRowState, resolveQueueReorder, upNextCount } from "./queueRowState";

// -- i18n Imports --
import { useT } from "../../i18n";

// -- Style Imports --
import styles from "./QueueList.module.css";

/**
 * The up-next list beside the hero. Reads the queue, its metadata snapshot and the play cursor through
 * their own selectors, apart from the ticking status, so the playhead moving never re-renders these rows.
 * The header counts the tracks still ahead and holds the sequencing control; the footer clears the queue
 * by stopping the engine.
 */
export function QueueList() {
  const queue = usePlayerQueue();
  const meta = usePlayerQueueMeta();
  const queueIndex = usePlayerQueueIndex();
  const actions = usePlayerActions();
  const t = useT();

  const ahead = upNextCount(queue.length, queueIndex);

  // One sortable id per slot, not per track: the queue is a flat id list with possible duplicates, so a
  // repeated track carries a distinct slot id, which is also the row key. Every slot registers for stable
  // geometry; only up-next rows actually lift.
  const items = useMemo(() => queue.map((id, i) => `${id}:${i}`), [queue]);

  // A few px of travel arms a drag; the keyboard sensor drives the accessible reorder off the grip.
  const sensors = useSensors(
    useSensor(PointerSensor, { activationConstraint: { distance: 4 } }),
    useSensor(KeyboardSensor, { coordinateGetter: sortableKeyboardCoordinates }),
  );

  const onDragEnd = ({ active, over }: DragEndEvent) => {
    if (!over || over.id === active.id) return;
    const from = items.indexOf(String(active.id));
    const to = items.indexOf(String(over.id));
    // Clamp a drop out of played/now territory and drop a no-op; the store reorders optimistically and
    // the engine echo reconciles.
    const move = resolveQueueReorder(from, to, queueIndex);
    if (move) actions.reorderQueue(move.from, move.to);
  };

  return (
    <div className={styles.queue}>
      <div className={styles.header}>
        <div className={styles.heading}>
          <span className={styles.label}>{t((d) => d.player.upNext)}</span>
          <span className={styles.count}>{formatCount(ahead)}</span>
        </div>
        <SequenceMenu />
      </div>

      <ScrollArea className={styles.scroll}>
        <DndContext
          sensors={sensors}
          // Resolve drops against live row geometry, never a drag-start snapshot: an optimistic reorder
          // remounts the rows mid-interaction.
          measuring={{ droppable: { strategy: MeasuringStrategy.Always } }}
          onDragEnd={onDragEnd}
        >
          <SortableContext items={items} strategy={verticalListSortingStrategy}>
            <div className={styles.rows}>
              {queue.map((id, i) => {
                const m = meta[id];
                return (
                  <QueueRow
                    key={items[i]}
                    id={items[i]}
                    state={queueRowState(i, queueIndex)}
                    displayNo={i + 1}
                    title={m?.title ?? ""}
                    artist={m?.artist ?? null}
                    durationSecs={m?.durationSecs ?? null}
                    unknownLabel={t((d) => d.player.unknownTrack)}
                    reorderLabel={t((d) => d.player.reorderQueue)}
                    removeLabel={t((d) => d.player.removeFromQueue)}
                    onJump={() => actions.jump(i)}
                    onRemove={() => actions.removeFromQueue(i)}
                  />
                );
              })}
            </div>
          </SortableContext>
        </DndContext>
      </ScrollArea>

      <div className={styles.footer}>
        <QuietButton onClick={() => actions.stop()}>{t((d) => d.player.clearQueue)}</QuietButton>
      </div>
    </div>
  );
}
