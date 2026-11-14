// -- Framework Imports --
import { useRef } from "react";

// -- Component Imports --
import { Toast } from "../common/Toast/Toast";

// -- State Imports --
import { useQueueToast } from "../../state/player/queueToast";

// -- Type Imports --
import type { Translate } from "../../i18n";
import type { QueueNotice } from "../../state/player/queueToast";

// -- i18n Imports --
import { useT } from "../../i18n";

// -- Style Imports --
import styles from "./QueueToast.module.css";

/** The localized line of a notice. */
function noticeText(t: Translate, notice: QueueNotice): string {
  switch (notice.kind) {
    case "added":
      return t((d) => d.player.addedToQueue, { n: notice.count });
    case "cleared":
      return t((d) => d.player.stream.cleared, { name: notice.name });
    case "clearedPlain":
      return t((d) => d.player.stream.clearedPlain);
    case "playsAfter":
      return t((d) => d.player.stream.playsAfter, { title: notice.title });
  }
}

/**
 * The nudge after a queue change: a neutral pill at the foot of the window, on the same material as the
 * selection bar. An append reads the cumulative count so a burst shows one pill; a stream's parked queue
 * adds the cleared and plays-after lines. Mount once near the app's overlays. A cold notice has no count,
 * so a ref keeps the last line through the fade.
 */
export function QueueToast() {
  const { notice, visible } = useQueueToast();
  const t = useT();

  const lastLine = useRef("");
  if (visible) lastLine.current = noticeText(t, notice);

  return (
    <Toast visible={visible}>
      <span className={styles.text}>{lastLine.current}</span>
    </Toast>
  );
}
