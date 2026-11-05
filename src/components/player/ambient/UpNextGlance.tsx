// -- State Imports --
import { usePlayerQueue, usePlayerQueueIndex, usePlayerQueueMeta } from "../../../state/player/store";

// -- i18n Imports --
import { useT } from "../../../i18n";

// -- Style Imports --
import styles from "./AmbientStage.module.css";

/**
 * The up-next glance in ambient mode's chrome: the next track's title over its artist and the one after.
 * It reads the play order, so on the last track (or once playback has stopped) it holds an empty cell
 * that keeps the transport centred.
 */
export function UpNextGlance({ active }: { active: boolean }) {
  const queue = usePlayerQueue();
  const meta = usePlayerQueueMeta();
  const index = usePlayerQueueIndex();
  const t = useT();

  const nextId = active ? queue[index + 1] : undefined;
  if (nextId == null) return <span />;
  const next = meta[nextId];
  const thenId = queue[index + 2];
  const then = thenId != null ? meta[thenId] : undefined;
  const title = next?.title || t((d) => d.player.unknownTrack);
  const detail = [
    next?.artist ?? null,
    then ? t((d) => d.player.upNextThen, { title: then.title || t((d) => d.player.unknownTrack) }) : null,
  ]
    .filter((part): part is string => part != null)
    .join(" \u00b7 ");

  return (
    <div className={styles.glance}>
      <span className={styles.glanceLabel}>{t((d) => d.player.upNext)}</span>
      <span className={styles.glanceTitle}>{title}</span>
      {detail ? <span className={styles.glanceDetail}>{detail}</span> : null}
    </div>
  );
}
