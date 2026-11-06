// -- Icon Imports --
import { Sparkles, X } from "lucide-react";

// -- i18n Imports --
import { useT } from "../../i18n";

// -- Style Imports --
import styles from "./BrowseHint.module.css";

/**
 * The one-time invitation into Browse, hung under the Collection switch. The pill opens Browse; its x
 * only dismisses. Either retires the hint for good, which the caller owns.
 */
export function BrowseHint({ onOpen, onDismiss }: { onOpen: () => void; onDismiss: () => void }) {
  const t = useT();
  return (
    <div className={styles.hint}>
      <button type="button" className={styles.open} onClick={onOpen}>
        <Sparkles size={14} strokeWidth={1.8} aria-hidden="true" />
        {t((d) => d.collection.browseHint)}
      </button>
      <button
        type="button"
        className={styles.dismiss}
        onClick={onDismiss}
        aria-label={t((d) => d.collection.browseHintDismiss)}
      >
        <X size={13} strokeWidth={2} aria-hidden="true" />
      </button>
    </div>
  );
}
