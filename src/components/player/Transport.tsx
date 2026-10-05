// -- Framework Imports --
import type { HTMLAttributes, ReactElement } from "react";

// -- Icon Imports --
import { Pause, Play, SkipBack, SkipForward } from "lucide-react";

// -- Component Imports --
import { IconButton } from "../common/IconButton";
import { Tooltip } from "../common/Tooltip";

// -- State Imports --
import { useIsPlaying, usePlayerActions } from "../../state/player/store";

// -- Utils Imports --
import { COMBOS, withShortcut } from "../shortcuts/shortcutCatalog";

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
 * surface without changing the layout. `shortcutHints` names each button's key in a tooltip; only the
 * main window binds those keys, so the other windows leave it off.
 */
export function Transport({
  size = "md",
  shortcutHints = false,
}: {
  size?: "md" | "lg";
  shortcutHints?: boolean;
}) {
  const playing = useIsPlaying();
  const actions = usePlayerActions();
  const t = useT();
  const s = SIZES[size];

  const hint = (label: string, button: ReactElement<HTMLAttributes<HTMLElement>>) =>
    shortcutHints ? <Tooltip label={label}>{button}</Tooltip> : button;

  return (
    <div className={styles.transport}>
      {hint(
        withShortcut(t((d) => d.shortcuts.previousTrack), [COMBOS.prev], t),
        <IconButton aria-label={t((d) => d.player.previous)} onClick={() => actions.prev()}>
          <SkipBack size={s.skip} strokeWidth={s.stroke} />
        </IconButton>,
      )}
      {hint(
        withShortcut(t((d) => d.shortcuts.playPause), [COMBOS.togglePlay], t),
        <IconButton
          aria-label={playing ? t((d) => d.player.pause) : t((d) => d.player.play)}
          onClick={() => actions.toggle()}
        >
          {playing ? (
            <Pause size={s.play} strokeWidth={s.stroke} />
          ) : (
            <Play size={s.play} strokeWidth={s.stroke} />
          )}
        </IconButton>,
      )}
      {hint(
        withShortcut(t((d) => d.shortcuts.nextTrack), [COMBOS.next], t),
        <IconButton aria-label={t((d) => d.player.next)} onClick={() => actions.next()}>
          <SkipForward size={s.skip} strokeWidth={s.stroke} />
        </IconButton>,
      )}
    </div>
  );
}
