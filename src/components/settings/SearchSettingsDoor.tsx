// -- Icon Imports --
import { Search } from "lucide-react";

// -- i18n Imports --
import { useT } from "../../i18n";

// -- Style Imports --
import styles from "./SettingsView.module.css";

/**
 * The Settings head's way into the finder, scoped to Settings. A quiet text button, not a field: it
 * hands the element to the opener so a dismissal can return focus here.
 */
export function SearchSettingsDoor({ onOpen }: { onOpen: (door: HTMLElement) => void }) {
  const t = useT();
  return (
    <button type="button" className={styles.door} aria-haspopup="dialog" onClick={(e) => onOpen(e.currentTarget)}>
      <Search size={16} strokeWidth={1.8} aria-hidden="true" />
      <span>{t((d) => d.finder.scopePlaceholder)}</span>
    </button>
  );
}
