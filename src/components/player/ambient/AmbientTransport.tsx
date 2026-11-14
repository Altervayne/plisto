// -- Framework Imports --
import type { ReactElement } from "react";

// -- Icon Imports --
import { Pause, Play, SkipBack, SkipForward } from "lucide-react";

// -- Component Imports --
import { IconButton } from "../../common/IconButton";
import { Tooltip } from "../../common/Tooltip";

// -- State Imports --
import { useIsPlaying, usePlayerActions, useSeatedStream } from "../../../state/player/store";
import { showsPause, skipAllowed } from "../../../state/player/streamView";

// -- i18n Imports --
import { useT } from "../../../i18n";

// -- Style Imports --
import styles from "./AmbientStage.module.css";

/**
 * Ambient mode's transport: previous and next as quiet glyphs around a large round play button, the
 * stage's one solid accent, so it reads from across a room. With a plugin stream seated the button
 * follows the stream's own state, and a skip the plugin did not accept is dimmed and inert.
 */
export function AmbientTransport() {
  const enginePlaying = useIsPlaying();
  const stream = useSeatedStream();
  const actions = usePlayerActions();
  const t = useT();

  const playing = stream ? showsPause(stream) : enginePlaying;
  const onToggle = () => {
    if (!stream) actions.toggle();
    else if (playing) actions.pause();
    else actions.resume();
  };
  const prevOk = skipAllowed(stream, "prev");
  const nextOk = skipAllowed(stream, "next");

  // A refused skip is dimmed, kept hoverable so its tooltip can say why, as in the main transport.
  const skip = (ok: boolean, label: string, go: () => void, glyph: ReactElement) => {
    const button = (
      <IconButton aria-label={label} aria-disabled={ok ? undefined : "true"} onClick={ok ? go : undefined}>
        {glyph}
      </IconButton>
    );
    if (ok || !stream) return button;
    return <Tooltip label={t((d) => d.player.stream.noSkip, { name: stream.plugin_name })}>{button}</Tooltip>;
  };

  return (
    <div className={styles.cluster}>
      {skip(
        prevOk,
        t((d) => d.player.previous),
        () => actions.prev(),
        <SkipBack size={22} strokeWidth={1.8} />,
      )}
      <button
        type="button"
        className={styles.play}
        aria-label={playing ? t((d) => d.player.pause) : t((d) => d.player.play)}
        onClick={onToggle}
      >
        {playing ? <Pause size={24} strokeWidth={1.8} /> : <Play size={24} strokeWidth={1.8} />}
      </button>
      {skip(
        nextOk,
        t((d) => d.player.next),
        () => actions.next(),
        <SkipForward size={22} strokeWidth={1.8} />,
      )}
    </div>
  );
}
