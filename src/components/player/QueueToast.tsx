// -- Framework Imports --
import { useRef } from "react";

// -- Component Imports --
import { Toast } from "../common/Toast/Toast";

// -- State Imports --
import { useQueueToast } from "../../state/player/queueToast";

// -- i18n Imports --
import { useT } from "../../i18n";

// -- Style Imports --
import styles from "./QueueToast.module.css";

/**
 * The nudge after a menu append: a neutral pill at the foot of the window, on the same material as the
 * selection bar. It reads the cumulative count so a burst shows one pill. Mount once near the app's
 * overlays. The count empties as the pill dismisses, so a ref keeps the last tally through the fade.
 */
export function QueueToast() {
  const { count, visible } = useQueueToast();
  const t = useT();

  const lastCount = useRef(0);
  if (count > 0) lastCount.current = count;

  return (
    <Toast visible={visible}>
      <span className={styles.text}>{t((d) => d.player.addedToQueue, { n: lastCount.current })}</span>
    </Toast>
  );
}
