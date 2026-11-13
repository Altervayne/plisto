// -- Component Imports --
import { Tooltip } from "../common/Tooltip";

// -- State Imports --
import { useFramePhase } from "../../state/plugins/frameHealth";

// -- i18n Imports --
import { useT } from "../../i18n";

// -- Style Imports --
import styles from "./FrameMark.module.css";

/** Whether the plugin's frame is not responding or has stopped, so its rail row carries the mark. */
export function useFrameMarked(id: string): boolean {
  const phase = useFramePhase(id);
  return phase === "not_responding" || phase === "crashed";
}

/**
 * The rail's mark after a plugin's name: a static warn dot while its frame is not responding or has
 * stopped, nothing otherwise. Its only source is the frame's phase, so it decorates rows the rail
 * already draws and never decides whether a row shows.
 */
export function FrameMark({ id, name }: { id: string; name: string }) {
  const t = useT();
  const phase = useFramePhase(id);
  const marked = useFrameMarked(id);
  if (!marked) return null;
  const label = t((d) => (phase === "crashed" ? d.plugins.frame.railStopped : d.plugins.frame.railNotResponding), {
    name,
  });
  return (
    <Tooltip label={label}>
      <span className={styles.dot} role="img" aria-label={label} />
    </Tooltip>
  );
}
