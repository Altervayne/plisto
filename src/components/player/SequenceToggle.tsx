// -- Icon Imports --
import { Repeat, Repeat1, Shuffle } from "lucide-react";

// -- Component Imports --
import { IconToggle } from "../common/IconToggle";
import { Tooltip } from "../common/Tooltip";

// -- State Imports --
import { usePlayerActions, usePlayerStatus, useSeatedStream } from "../../state/player/store";

// -- Local Imports --
import { nextRepeat } from "./sequenceState";

// -- i18n Imports --
import { useT } from "../../i18n";

/**
 * One sequencing toggle flanking the transport cluster: shuffle on the leading side, repeat on the
 * trailing side. Shuffle flips the engine flag; repeat steps off, all, one, and its glyph and label name
 * the mode (Repeat1 for one). Pressed reads as the raised chip, never an accent. While a plugin stream is
 * seated both stay in place but dimmed and inert: aria-disabled keeps them focusable and hoverable, so the
 * tooltip can say why, and a press does nothing because the parked queue is neither shuffled nor repeated.
 */
export function SequenceToggle({ kind }: { kind: "shuffle" | "repeat" }) {
  const status = usePlayerStatus();
  const actions = usePlayerActions();
  const stream = useSeatedStream();
  const t = useT();

  const inert = stream != null;
  const on = kind === "shuffle" ? status.shuffle : status.repeat !== "off";
  const label =
    kind === "shuffle"
      ? t((d) => d.player.shuffle)
      : status.repeat === "one"
        ? t((d) => d.player.repeatCurrent)
        : status.repeat === "all"
          ? t((d) => d.player.repeatQueue)
          : t((d) => d.player.playOnce);
  const glyph =
    kind === "shuffle" ? (
      <Shuffle size={18} strokeWidth={1.8} />
    ) : status.repeat === "one" ? (
      <Repeat1 size={18} strokeWidth={1.8} />
    ) : (
      <Repeat size={18} strokeWidth={1.8} />
    );

  const onPress = () => {
    if (inert) return;
    if (kind === "shuffle") actions.setShuffle(!status.shuffle);
    else actions.setRepeat(nextRepeat(status.repeat));
  };

  return (
    <Tooltip label={inert ? t((d) => d.player.noSequence, { name: stream.plugin_name }) : label}>
      <IconToggle
        pressed={on && !inert}
        aria-label={label}
        aria-disabled={inert ? "true" : undefined}
        onClick={onPress}
      >
        {glyph}
      </IconToggle>
    </Tooltip>
  );
}
