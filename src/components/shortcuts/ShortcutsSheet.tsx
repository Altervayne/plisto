// -- Framework Imports --
import { useCallback, useEffect, useState } from "react";
import { createPortal } from "react-dom";

// -- Component Imports --
import { QuietButton } from "../common/QuietButton";

// -- Hook Imports --
import { useMountTransition } from "../../hooks/useMountTransition";

// -- State Imports --
import { usePlayerEnabled } from "../../state/player/store";

// -- Utils Imports --
import { SHORTCUT_GROUPS, keyLabel } from "./shortcutCatalog";

// -- Type Imports --
import type { Combo } from "./shortcutCatalog";

// -- i18n Imports --
import { useT } from "../../i18n";

// -- Style Imports --
import styles from "./ShortcutsSheet.module.css";

/** The card's exit before it unmounts, matching --dur-soft on the exit keyframe. */
const EXIT_MS = 200;

/** One combination as key caps. */
function Keys({ combo }: { combo: Combo }) {
  const t = useT();
  return (
    <span className={styles.keys}>
      {combo.map((cap) => (
        <kbd key={cap} className={styles.cap}>
          {keyLabel(cap, t)}
        </kbd>
      ))}
    </span>
  );
}

/**
 * The keyboard shortcuts reference, a dimmed modal listing every app-wide key by group. Playback keys
 * do nothing while the player is off, so their group hides with it. Escape and the backdrop close it.
 * Portals to the body.
 */
export function ShortcutsSheet({ onClose }: { onClose: () => void }) {
  const t = useT();
  const playerEnabled = usePlayerEnabled();

  // Own the card's lifetime so a close plays its exit before the parent drops it.
  const [open, setOpen] = useState(true);
  const card = useMountTransition(open, EXIT_MS);
  const requestClose = useCallback(() => setOpen(false), []);
  useEffect(() => {
    if (!card.mounted) onClose();
  }, [card.mounted, onClose]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") requestClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [requestClose]);

  if (!card.mounted) return null;

  const title = t((d) => d.shortcuts.title);
  const groups = SHORTCUT_GROUPS.filter((group) => playerEnabled || group.id !== "playback");

  return createPortal(
    <div className={styles.overlay} data-state={card.state}>
      <div className={styles.backdrop} onClick={requestClose} aria-hidden="true" />

      <div className={styles.panel} role="dialog" aria-modal="true" aria-label={title}>
        <div className={styles.header}>
          <h2 className={styles.title}>{title}</h2>
          <QuietButton onClick={requestClose} aria-label={t((d) => d.common.close)}>
            {t((d) => d.common.close)}
          </QuietButton>
        </div>

        {groups.map((group) => (
          <section key={group.id} className={styles.group}>
            <h3 className={styles.label}>{t(group.label)}</h3>
            <dl className={styles.rows}>
              {group.rows.map((row) => (
                <div key={row.combo.join("+")} className={styles.row}>
                  <dt className={styles.action}>{t(row.label)}</dt>
                  <dd className={styles.combo}>
                    <Keys combo={row.combo} />
                  </dd>
                </div>
              ))}
            </dl>
          </section>
        ))}
      </div>
    </div>,
    document.body,
  );
}
