// -- Framework Imports --
import type { HTMLAttributes, ReactElement } from "react";

// -- Icon Imports --
import { Pause, Play, SkipBack, SkipForward, Square } from "lucide-react";

// -- Component Imports --
import { IconButton } from "../common/IconButton";
import { Tooltip } from "../common/Tooltip";

// -- State Imports --
import { useIsPlaying, usePlayerActions, useSeatedStream } from "../../state/player/store";
import { showsPause } from "../../state/player/streamView";

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
 *
 * With a plugin stream seated the cluster follows the stream: the main button reads the hub's state
 * (Pause in every state but paused, so a press during a wait stops the wait), Next and Previous dim
 * unless the plugin accepts them (kept hoverable so the tooltip can say so), and `withStop` adds Stop
 * after Next.
 */
export function Transport({
  size = "md",
  shortcutHints = false,
  withStop = false,
}: {
  size?: "md" | "lg";
  shortcutHints?: boolean;
  withStop?: boolean;
}) {
  const enginePlaying = useIsPlaying();
  const stream = useSeatedStream();
  const actions = usePlayerActions();
  const t = useT();
  const s = SIZES[size];

  const playing = stream ? showsPause(stream) : enginePlaying;
  const onToggle = () => {
    if (!stream) actions.toggle();
    else if (playing) actions.pause();
    else actions.resume();
  };

  const hint = (label: string, button: ReactElement<HTMLAttributes<HTMLElement>>) =>
    shortcutHints ? <Tooltip label={label}>{button}</Tooltip> : button;

  // A skip the plugin did not accept: dimmed and inert, with the reason as its tooltip.
  const skip = (
    accepted: boolean,
    shortcutLabel: string,
    label: string,
    go: () => void,
    glyph: ReactElement,
  ) => {
    if (!stream || accepted) {
      return hint(shortcutLabel, <IconButton aria-label={label} onClick={go}>{glyph}</IconButton>);
    }
    return (
      <Tooltip label={t((d) => d.player.stream.noSkip, { name: stream.plugin_name })}>
        <IconButton aria-label={label} aria-disabled="true">
          {glyph}
        </IconButton>
      </Tooltip>
    );
  };

  return (
    <div className={styles.transport}>
      {skip(
        stream?.skip.prev ?? true,
        withShortcut(t((d) => d.shortcuts.previousTrack), [COMBOS.prev], t),
        t((d) => d.player.previous),
        () => actions.prev(),
        <SkipBack size={s.skip} strokeWidth={s.stroke} />,
      )}
      {hint(
        withShortcut(t((d) => d.shortcuts.playPause), [COMBOS.togglePlay], t),
        <IconButton
          aria-label={playing ? t((d) => d.player.pause) : t((d) => d.player.play)}
          onClick={onToggle}
        >
          {playing ? (
            <Pause size={s.play} strokeWidth={s.stroke} />
          ) : (
            <Play size={s.play} strokeWidth={s.stroke} />
          )}
        </IconButton>,
      )}
      {skip(
        stream?.skip.next ?? true,
        withShortcut(t((d) => d.shortcuts.nextTrack), [COMBOS.next], t),
        t((d) => d.player.next),
        () => actions.next(),
        <SkipForward size={s.skip} strokeWidth={s.stroke} />,
      )}
      {stream && withStop ? (
        <Tooltip label={t((d) => d.player.stop)}>
          <IconButton aria-label={t((d) => d.player.stop)} onClick={() => actions.stop()}>
            <Square size={s.skip} strokeWidth={s.stroke} />
          </IconButton>
        </Tooltip>
      ) : null}
    </div>
  );
}
