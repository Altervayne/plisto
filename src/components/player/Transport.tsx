// -- Icon Imports --
import { Pause, Play, SkipBack, SkipForward } from "lucide-react";

// -- Component Imports --
import { IconButton } from "../common/IconButton";

// -- State Imports --
import { useIsPlaying, usePlayerActions } from "../../state/player/store";

// -- i18n Imports --
import { useT } from "../../i18n";

// -- Style Imports --
import styles from "./Transport.module.css";

/** Glyph sizes and stroke per transport scale: "md" is the mini's, "lg" the roomier pop-out's. */
const SIZES = {
  md: { skip: 17, play: 19, stroke: 1.8 },
  lg: { skip: 20, play: 22, stroke: 1.8 },
} as const;

/**
 * The prev / play-pause / next cluster, wired to the engine itself: it reads the playing flag for the
 * glyph and pokes the transport actions, so any surface drops it in with no props. Neutral chrome -
 * the transparent IconButton veils on hover, never the accent. `size` scales the glyphs for a bigger
 * surface without changing the layout.
 */
export function Transport({ size = "md" }: { size?: "md" | "lg" }) {
  const playing = useIsPlaying();
  const actions = usePlayerActions();
  const t = useT();
  const s = SIZES[size];

  return (
    <div className={styles.transport}>
      <IconButton aria-label={t((d) => d.player.previous)} onClick={() => actions.prev()}>
        <SkipBack size={s.skip} strokeWidth={s.stroke} />
      </IconButton>
      <IconButton
        aria-label={playing ? t((d) => d.player.pause) : t((d) => d.player.play)}
        onClick={() => actions.toggle()}
      >
        {playing ? (
          <Pause size={s.play} strokeWidth={s.stroke} />
        ) : (
          <Play size={s.play} strokeWidth={s.stroke} />
        )}
      </IconButton>
      <IconButton aria-label={t((d) => d.player.next)} onClick={() => actions.next()}>
        <SkipForward size={s.skip} strokeWidth={s.stroke} />
      </IconButton>
    </div>
  );
}
