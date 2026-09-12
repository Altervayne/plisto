// -- Icon Imports --
import { Headphones, LibraryBig, Blend } from "lucide-react";

// -- Component Imports --
import { SegmentedControl } from "../common/SegmentedControl";

// -- State Imports --
import { useAppMode, useSetAppMode } from "../../state/player/store";
import type { AppMode } from "../../state/player/store";

// -- i18n Imports --
import { useT } from "../../i18n";

// -- Style Imports --
import styles from "./AppModeSwitch.module.css";

/**
 * The identity switch at the foot of the rail: Player, Organizer, or Both. It only gates the scattered
 * play affordances (see usePlayerEnabled) and never touches the engine, so switching to Organizer
 * leaves a playing track running, still reachable from the mini. Icon-only, since three labels crowd the
 * narrow rail; each segment names itself for a reader.
 */
export function AppModeSwitch() {
  const mode = useAppMode();
  const setMode = useSetAppMode();
  const t = useT();

  return (
    <div className={styles.wrap}>
      <SegmentedControl<AppMode>
        segments={[
          {
            value: "player",
            label: t((d) => d.player.modePlayer),
            icon: <Headphones size={15} strokeWidth={1.8} aria-hidden="true" />,
          },
          {
            value: "organizer",
            label: t((d) => d.player.modeOrganizer),
            icon: <LibraryBig size={15} strokeWidth={1.8} aria-hidden="true" />,
          },
          {
            value: "both",
            label: t((d) => d.player.modeBoth),
            icon: <Blend size={15} strokeWidth={1.8} aria-hidden="true" />,
          },
        ]}
        value={mode}
        onChange={setMode}
        label={t((d) => d.player.modeLabel)}
      />
    </div>
  );
}
