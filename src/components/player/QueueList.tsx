// -- Component Imports --
import { ScrollArea } from "../common/ScrollArea/ScrollArea";
import { QuietButton } from "../common/QuietButton";
import { QueueRow } from "./QueueRow";

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
import { queueRowState, upNextCount } from "./queueRowState";

// -- i18n Imports --
import { useT } from "../../i18n";

// -- Style Imports --
import styles from "./QueueList.module.css";

/**
 * The up-next list beside the hero. Reads the queue, its metadata snapshot and the play cursor through
 * their own selectors, apart from the ticking status, so the playhead moving never re-renders these rows.
 * The header counts the tracks still ahead; the footer clears the queue by stopping the engine.
 */
export function QueueList() {
  const queue = usePlayerQueue();
  const meta = usePlayerQueueMeta();
  const queueIndex = usePlayerQueueIndex();
  const actions = usePlayerActions();
  const t = useT();

  const ahead = upNextCount(queue.length, queueIndex);

  return (
    <div className={styles.queue}>
      <div className={styles.header}>
        <span className={styles.label}>{t((d) => d.player.upNext)}</span>
        <span className={styles.count}>{formatCount(ahead)}</span>
      </div>

      <ScrollArea className={styles.scroll} contentClassName={styles.rows}>
        {queue.map((id, i) => {
          const m = meta[id];
          return (
            <QueueRow
              key={`${id}:${i}`}
              state={queueRowState(i, queueIndex)}
              displayNo={i + 1}
              title={m?.title ?? ""}
              artist={m?.artist ?? null}
              durationSecs={m?.durationSecs ?? null}
              unknownLabel={t((d) => d.player.unknownTrack)}
              onJump={() => actions.jump(i)}
            />
          );
        })}
      </ScrollArea>

      <div className={styles.footer}>
        <QuietButton onClick={() => actions.stop()}>{t((d) => d.player.clearQueue)}</QuietButton>
      </div>
    </div>
  );
}
