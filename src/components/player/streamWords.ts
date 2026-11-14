// -- Type Imports --
import type { Translate } from "../../i18n";
import type { StreamWaitPhase } from "../../state/player/streamView";

/** The one static word for a waiting stream phase, shown in place of the line the wait interrupts. */
export function waitWord(t: Translate, phase: StreamWaitPhase): string {
  switch (phase) {
    case "connecting":
      return t((d) => d.player.stream.connecting);
    case "buffering":
      return t((d) => d.player.stream.buffering);
    case "reconnecting":
      return t((d) => d.player.stream.reconnecting);
  }
}
