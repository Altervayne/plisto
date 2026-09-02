// -- Framework Imports --
import { useRef } from "react";

// -- Hook Imports --
import { useMountTransition } from "../../hooks/useMountTransition";

// -- State Imports --
import { useQueueToast } from "../../state/player/queueToast";

// -- i18n Imports --
import { useT } from "../../i18n";

// -- Style Imports --
import styles from "./QueueToast.module.css";

/** The pill's exit before it unmounts, matching --dur-fast on the exit keyframe. */
const EXIT_MS = 120;

/**
 * The nudge after a menu append: a neutral pill at the foot of the window, on the same material as the
 * selection bar. It holds no accent - the append is quiet feedback, not a call to act - and reads the
 * cumulative count so a burst shows one pill. Mount it once near the app's other overlays. The count
 * empties as the pill dismisses, so a ref keeps the last tally on screen through the fade.
 */
export function QueueToast() {
  const { count, visible } = useQueueToast();
  const t = useT();
  const toast = useMountTransition(visible, EXIT_MS);

  const lastCount = useRef(0);
  if (count > 0) lastCount.current = count;

  if (!toast.mounted) return null;

  return (
    <div className={styles.toast} data-state={toast.state} role="status" aria-live="polite">
      <span className={styles.text}>{t((d) => d.player.addedToQueue, { n: lastCount.current })}</span>
    </div>
  );
}
