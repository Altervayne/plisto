// -- Component Imports --
import { QuietButton } from "../common/QuietButton";

// -- i18n Imports --
import { useT } from "../../i18n";

// -- Type Imports --
import type { TakeoverView } from "./takeoverModel";

// -- Style Imports --
import dotStyles from "../plugins/StatusDot.module.css";
import styles from "./TakeoverNotice.module.css";

/**
 * The block at the top of the Sound card while a plugin holds the output, or just lost it. Plisto's own
 * sentence leads; the holder's report is a quieter line beneath and never inside the sentence. The dot is
 * the rail's cyan or amber and static. The not-responding variant has no button: Plisto already took the
 * speakers back.
 */
export function TakeoverNotice({
  view,
  busy,
  onReturn,
  stream = false,
}: {
  view: TakeoverView;
  busy: boolean;
  onReturn: () => void;
  /** A plugin's stream is the sound playing: the sentence names Plisto's sound rather than the user's music. */
  stream?: boolean;
}) {
  const t = useT();
  const held = view.kind === "held";
  const line = held
    ? view.name == null
      ? t((d) => (stream ? d.sound.takeoverHeldStreamUnknown : d.sound.takeoverHeldUnknown))
      : t((d) => (stream ? d.sound.takeoverHeldStream : d.sound.takeoverHeld), { name: view.name })
    : t((d) => d.sound.takeoverNotResponding, { name: view.name });

  return (
    <div className={styles.take}>
      <div className={styles.line}>
        <span className={`${dotStyles.dot} ${held ? dotStyles.on : dotStyles.warn} ${styles.dot}`} aria-hidden="true" />
        <span className={styles.words}>
          {line}
          {held && view.text && <span className={styles.report}>{view.text}</span>}
        </span>
      </div>
      {held && (
        <span className={styles.action}>
          <QuietButton onClick={onReturn} disabled={busy}>
            {t((d) => d.sound.takeoverReturn)}
          </QuietButton>
        </span>
      )}
    </div>
  );
}
