// -- Icon Imports --
import { Pause, Play, SkipBack, SkipForward } from "lucide-react";

// -- Component Imports --
import { IconButton } from "../../common/IconButton";

// -- State Imports --
import { useIsPlaying, usePlayerActions } from "../../../state/player/store";

// -- i18n Imports --
import { useT } from "../../../i18n";

// -- Style Imports --
import styles from "./AmbientStage.module.css";

/**
 * Ambient mode's transport: previous and next as quiet glyphs around a large round play button, the
 * stage's one solid accent, so it reads from across a room.
 */
export function AmbientTransport() {
  const playing = useIsPlaying();
  const actions = usePlayerActions();
  const t = useT();

  return (
    <div className={styles.cluster}>
      <IconButton aria-label={t((d) => d.player.previous)} onClick={() => actions.prev()}>
        <SkipBack size={22} strokeWidth={1.8} />
      </IconButton>
      <button
        type="button"
        className={styles.play}
        aria-label={playing ? t((d) => d.player.pause) : t((d) => d.player.play)}
        onClick={() => actions.toggle()}
      >
        {playing ? <Pause size={24} strokeWidth={1.8} /> : <Play size={24} strokeWidth={1.8} />}
      </button>
      <IconButton aria-label={t((d) => d.player.next)} onClick={() => actions.next()}>
        <SkipForward size={22} strokeWidth={1.8} />
      </IconButton>
    </div>
  );
}
