// -- Framework Imports --
import { useEffect, useMemo, useRef, useState } from "react";
import type { HTMLAttributes, ReactElement } from "react";

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
import { Tooltip } from "../common/Tooltip";
import { QueueRow } from "./QueueRow";
import { QueueStreamCard } from "./QueueStreamCard";

// -- State Imports --
import {
  usePlayerActions,
  usePlayerQueue,
  usePlayerQueueIndex,
  usePlayerQueueMeta,
  useHasParked,
  useSeatedStream,
} from "../../state/player/store";
import { cleared } from "../../state/player/queueToast";
import { clearSavedResume } from "../../state/player/useResumeWriter";

import { useAddTracksToPlaylist, useCreatePlaylist } from "../../state/playlists/store";
import { queuePlaylistName, queuePlaylistTrackIds } from "../../state/player/queuePlaylist";

// -- Format Imports --
import { formatCount } from "../../lib/format";

// -- Local Imports --
import { queueRowState, resolveQueueReorder, upNextCount } from "./queueRowState";

// -- i18n Imports --
import { useT } from "../../i18n";

// -- Style Imports --
import styles from "./QueueList.module.css";

/** How long the header action reads as saved before it returns to its label. */
const SAVED_MS = 2000;

/**
 * The up-next list beside the hero. Reads the queue, its metadata snapshot and the play cursor through
 * their own selectors, apart from the ticking status, so the playhead moving never re-renders these rows.
 * The header counts the tracks still ahead and holds the save-as-playlist action; the footer clears the
 * queue by stopping the engine.
 *
 * While a plugin stream holds the seat the column shows the stream's card, then the parked queue under a
 * sentence naming the plugin. Its rows read as paused (none is marked playing; the cursor row shows the
 * pause glyph only when the engine holds a parked track), Save as playlist saves the
 * parked queue, and Clear queue empties only that queue: it never stops the stream, so it moves into the
 * header beside Save and the footer goes.
 * The column sits on a glass backing (`.queue::before`).
 */
export function QueueList() {
  const queue = usePlayerQueue();
  const meta = usePlayerQueueMeta();
  const queueIndex = usePlayerQueueIndex();
  const actions = usePlayerActions();
  const stream = useSeatedStream();
  const hasParked = useHasParked();
  const createPlaylist = useCreatePlaylist();
  const addTracksToPlaylist = useAddTracksToPlaylist();
  const t = useT();
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const savingRef = useRef(false);

  useEffect(() => {
    if (!saved) return;
    const timer = window.setTimeout(() => setSaved(false), SAVED_MS);
    return () => window.clearTimeout(timer);
  }, [saved]);

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

  const libraryIds = useMemo(() => queuePlaylistTrackIds(queue), [queue]);

  // The whole queue in play order, played tracks included. The ref blocks a second click before the
  // disabled state renders, so a double click cannot create two playlists.
  const onSave = async () => {
    if (savingRef.current) return;
    savingRef.current = true;
    setSaving(true);
    try {
      const name = queuePlaylistName(t((d) => d.player.queuePlaylistName), new Date());
      const playlistId = await createPlaylist(name);
      await addTracksToPlaylist(playlistId, libraryIds);
      setSaved(true);
    } finally {
      savingRef.current = false;
      setSaving(false);
    }
  };

  // With no stream the queue is the saved session: stopping alone would bring it back at the next launch.
  const onClearQueue = () => {
    clearSavedResume();
    actions.stop();
  };

  const onClear = () => {
    if (!stream) return;
    actions.clearParked();
    cleared(stream.plugin_name);
  };

  const saveButton = (
    <QuietButton disabled={libraryIds.length === 0 || saving || saved} onClick={() => void onSave()}>
      {t((d) => (saved ? d.player.queueSavedAsPlaylist : d.player.saveQueueAsPlaylist))}
    </QuietButton>
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
      {stream ? <QueueStreamCard stream={stream} /> : null}
      {stream ? (
        <div className={styles.headerParked}>
          <p className={styles.park}>
            {t((d) => d.player.stream.parkedHeader, { name: stream.plugin_name })}
          </p>
          <div className={styles.parkActions}>
            {withHint(t((d) => d.player.stream.saveParkedHint), saveButton)}
            {withHint(
              t((d) => d.player.stream.clearParkedHint),
              <QuietButton disabled={queue.length === 0} onClick={onClear}>
                {t((d) => d.player.clearQueue)}
              </QuietButton>,
            )}
          </div>
        </div>
      ) : (
        <div className={styles.header}>
          <div className={styles.heading}>
            <span className={styles.label}>{t((d) => d.player.upNext)}</span>
            <span className={styles.count}>{formatCount(ahead)}</span>
          </div>
          <div className={styles.actions}>{saveButton}</div>
        </div>
      )}

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
              {stream && queue.length === 0 ? (
                <p className={styles.empty}>{t((d) => d.player.stream.parkedEmpty)}</p>
              ) : null}
              {queue.map((id, i) => {
                const m = meta[id];
                return (
                  <QueueRow
                    key={items[i]}
                    id={items[i]}
                    state={queueRowState(i, queueIndex, stream ? { parked: hasParked } : null)}
                    dim={stream != null}
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

      {stream ? null : (
        <div className={styles.footer}>
          <QuietButton onClick={onClearQueue}>{t((d) => d.player.clearQueue)}</QuietButton>
        </div>
      )}
    </div>
  );
}

/** Wraps a header action in its tooltip when it has a hint; a bare button otherwise. */
function withHint(label: string | null, button: ReactElement<HTMLAttributes<HTMLElement>>) {
  return label ? <Tooltip label={label}>{button}</Tooltip> : button;
}
