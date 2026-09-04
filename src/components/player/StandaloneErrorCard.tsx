// -- Icon Imports --
import { FileX2 } from "lucide-react";

// -- Component Imports --
import { QuietButton } from "../common/QuietButton";

// -- i18n Imports --
import { useT } from "../../i18n";

// -- Style Imports --
import styles from "./StandaloneErrorCard.module.css";

/**
 * The failure body, shown when the opened file cannot play at all: a muted icon over the localized line
 * and the file's own name, honest that the file was refused rather than the player's calm "nothing
 * playing" idle state. Fills the window with the same panel framing the player carries, so a refused file
 * reads on the same surface. The library escape sits beneath it; the title bar's close is always there too.
 */
export function StandaloneErrorCard({
  stem,
  onOpenLibrary,
}: {
  stem: string;
  onOpenLibrary: () => void;
}) {
  const t = useT();

  return (
    <div className={styles.stage}>
      <div className={styles.panel}>
        <FileX2 className={styles.icon} size={32} strokeWidth={1.5} aria-hidden="true" />
        <span className={styles.title}>{t((d) => d.player.cantPlayFile)}</span>
        <span className={styles.stem}>{stem}</span>
        <span className={styles.action}>
          <QuietButton onClick={onOpenLibrary}>{t((d) => d.window.openLibrary)}</QuietButton>
        </span>
      </div>
    </div>
  );
}
