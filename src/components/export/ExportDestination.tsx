// -- Icon Imports --
import { FolderOpen } from "lucide-react";

// -- i18n Imports --
import { useT } from "../../i18n";

// -- Style Imports --
import styles from "./ExportView.module.css";

/**
 * The destination control: a bordered, iconed button that reads plainly as an action, over the chosen
 * path when one is set. Empty it invites a pick; filled it offers a change, with the path shown mono
 * and truncated beside a good-tone dot, the full path on hover.
 */
export function ExportDestination({
  destination,
  onPick,
}: {
  destination: string | null;
  onPick: () => void;
}) {
  const t = useT();

  return (
    <div className={styles.destination}>
      <button type="button" className={styles.destButton} onClick={onPick}>
        <FolderOpen size={16} strokeWidth={1.9} aria-hidden="true" />
        {destination ? t((d) => d.export.changeDestination) : t((d) => d.export.chooseDestination)}
      </button>
      {destination ? (
        <span className={styles.chosen} title={destination}>
          <span className={styles.chosenDot} aria-hidden="true" />
          <span className={styles.chosenPath}>{destination}</span>
        </span>
      ) : null}
    </div>
  );
}
