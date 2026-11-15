// -- Framework Imports --
import type { Ref } from "react";

// -- Icon Imports --
import { Search } from "lucide-react";

// -- i18n Imports --
import { useT } from "../../i18n";

// -- Style Imports --
import styles from "./SearchPill.module.css";

/**
 * The sidebar's door into the quick finder: a button in the search field's recess look, never an input.
 * The finder's input row flies out of this button's box and back into it, reading its parts by the
 * data-pill-label and data-pill-hint marks; while open the pill hides itself. The Ctrl+K hint is
 * aria-hidden so the shortcut is announced once, from aria-keyshortcuts.
 */
export function SearchPill({ open, onOpen, pillRef }: { open: boolean; onOpen: () => void; pillRef?: Ref<HTMLButtonElement> }) {
  const t = useT();
  return (
    <button
      ref={pillRef}
      type="button"
      className={styles.pill}
      aria-haspopup="dialog"
      aria-expanded={open}
      aria-keyshortcuts="Control+K"
      onClick={onOpen}
    >
      <Search size={16} strokeWidth={1.8} className={styles.icon} aria-hidden="true" />
      <span className={styles.label} data-pill-label="">
        {t((d) => d.nav.search)}
      </span>
      <span className={styles.hint} data-pill-hint="" aria-hidden="true">
        {t((d) => d.nav.searchHint)}
      </span>
    </button>
  );
}
