// -- Framework Imports --
import { useEffect, useRef, useState } from "react";

// -- IPC Imports --
import { listCoverCandidates } from "../../lib/ipc";

// -- i18n Imports --
import { useT } from "../../i18n";

// -- Style Imports --
import styles from "./KeepOwnCoverToggle.module.css";

/**
 * The album-only keep-own-cover switch in the track peek: when on, the export embeds this track's own
 * embedded or adjacent art instead of the album cover. It is meaningful only when the track has art of
 * its own, so it probes the track's candidate sources and disables itself with a hint when there is
 * none - a flag there would silently fall back to the album cover anyway. The membership flag and its
 * write live in the caller; this only reflects and toggles it.
 */
export function KeepOwnCoverToggle({
  trackId,
  keepOwnCover,
  onChange,
}: {
  trackId: number;
  keepOwnCover: boolean;
  onChange: (next: boolean) => void;
}) {
  const t = useT();
  // Whether the track has art of its own (embedded or adjacent). Null while the probe is in flight, so
  // the switch stays inert rather than flashing a wrong disabled state.
  const [hasOwnArt, setHasOwnArt] = useState<boolean | null>(null);
  const requestId = useRef(0);

  useEffect(() => {
    const id = ++requestId.current;
    setHasOwnArt(null);
    void listCoverCandidates(trackId)
      .then((candidates) => {
        // Drop the result if a newer probe started while this one was in flight.
        if (id !== requestId.current) return;
        setHasOwnArt(candidates.length > 0);
      })
      .catch(() => {
        if (id !== requestId.current) return;
        setHasOwnArt(false);
      });
  }, [trackId]);

  const disabled = hasOwnArt !== true;

  return (
    <div className={styles.tag}>
      <div className={styles.row}>
        <span className={styles.label}>{t((d) => d.cover.keepOwnCover)}</span>
        <button
          type="button"
          role="switch"
          aria-checked={keepOwnCover}
          aria-label={t((d) => d.cover.keepOwnCover)}
          className={styles.switch}
          disabled={disabled}
          onClick={() => onChange(!keepOwnCover)}
        >
          <span className={styles.knob} aria-hidden="true" />
        </button>
      </div>
      {disabled && hasOwnArt === false ? (
        <span className={styles.hint}>{t((d) => d.cover.keepOwnCoverHint)}</span>
      ) : null}
    </div>
  );
}
