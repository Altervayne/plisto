// -- Framework Imports --
import { useState } from "react";

// -- Component Imports --
import { QuietButton } from "../common/QuietButton";

// -- Icon Imports --
import { ChevronRight } from "lucide-react";

// -- Utils Imports --
import { refusalText } from "./refusalText";

// -- Type Imports --
import type { DuplicateGroup } from "../../state/duplicates/findDuplicates";

// -- i18n Imports --
import { useT } from "../../i18n";

// -- Style Imports --
import styles from "./DuplicatesSheet.module.css";

/**
 * The sets no longer open, collapsed under a disclosure, each with Restore: those marked as not
 * duplicates and those merged, since a merge dismisses its pairs too.
 */
export function DismissedSection({
  groups,
  onRestore,
}: {
  groups: DuplicateGroup[];
  onRestore: (group: DuplicateGroup) => Promise<void>;
}) {
  const t = useT();
  const [open, setOpen] = useState(false);
  const [busy, setBusy] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  if (groups.length === 0) return null;

  const restore = async (group: DuplicateGroup) => {
    setBusy(group.key);
    setError(null);
    try {
      await onRestore(group);
    } catch (e) {
      setError(refusalText(e));
    } finally {
      setBusy(null);
    }
  };

  return (
    <div className={styles.dismissed}>
      <button
        type="button"
        className={styles.disclosure}
        aria-expanded={open}
        onClick={() => setOpen((v) => !v)}
      >
        <ChevronRight
          size={15}
          strokeWidth={1.8}
          className={open ? `${styles.chevron} ${styles.chevronOpen}` : styles.chevron}
          aria-hidden="true"
        />
        {t((d) => d.duplicates.dismissed, { n: groups.length })}
      </button>

      {open ? (
        <>
          {error ? (
            <p className={styles.error} role="alert">
              {error}
            </p>
          ) : null}
          <ul className={styles.dismissedList}>
            {groups.map((group) => (
              <li key={group.key} className={styles.dismissedRow}>
                <span className={styles.dismissedName}>
                  {group.title}
                  <span className={styles.dismissedArtist}> - {group.artist}</span>
                </span>
                <span className={styles.dismissedCount}>
                  {t((d) => d.duplicates.files, { n: group.trackIds.length })}
                </span>
                <QuietButton onClick={() => void restore(group)} disabled={busy != null}>
                  {t((d) => d.duplicates.restore)}
                </QuietButton>
              </li>
            ))}
          </ul>
        </>
      ) : null}
    </div>
  );
}
