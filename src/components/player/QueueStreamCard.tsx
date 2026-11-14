// -- Icon Imports --
import { Square } from "lucide-react";

// -- Component Imports --
import { Cover } from "../common/Cover/Cover";
import { IconButton } from "../common/IconButton";
import { StreamElapsed } from "./StreamElapsed";

// -- Hook Imports --
import { useTrackCover } from "../tracks/useTrackCover";

// -- State Imports --
import { usePlayerActions } from "../../state/player/store";
import { waitingPhase } from "../../state/player/streamView";

// -- Local Imports --
import { waitWord } from "./streamWords";

// -- Type Imports --
import type { StreamNow } from "../../types";

// -- i18n Imports --
import { useT } from "../../i18n";

// -- Style Imports --
import styles from "./QueueStreamCard.module.css";

/**
 * The seated plugin stream as the queue column shows it: the cover, the now line or title (one static word
 * while connecting, buffering or reconnecting), the plugin's name with the elapsed time of an item of known
 * length, and its own Stop. It is not a queue row: it cannot be dragged, removed or jumped to.
 */
export function QueueStreamCard({ stream }: { stream: StreamNow }) {
  const { cover } = useTrackCover(stream.item, false, stream.art_rev);
  const actions = usePlayerActions();
  const t = useT();

  const wait = waitingPhase(stream.state);
  const line = wait ? waitWord(t, wait) : (stream.now ?? stream.title);

  return (
    <div className={styles.card}>
      <span className={styles.cover}>
        <Cover src={cover?.src ?? null} alt="" />
      </span>
      <span className={styles.text}>
        <span className={styles.line}>{line}</span>
        <span className={styles.plugin}>
          <span className={styles.name}>{stream.plugin_name}</span>
          <StreamElapsed className={styles.tag} />
          {stream.state === "paused" ? (
            <span className={styles.tag}>{t((d) => d.player.stream.paused)}</span>
          ) : null}
        </span>
      </span>
      <IconButton aria-label={t((d) => d.player.stop)} onClick={() => actions.stop()}>
        <Square size={16} strokeWidth={1.8} />
      </IconButton>
    </div>
  );
}
