// -- i18n Imports --
import { useT } from "../../i18n";

// -- Style Imports --
import styles from "./GoneRailCard.module.css";

/** The rail card for tracks that cannot be found: the count, a line, Review to open the sheet, and Not now. */
export function GoneRailCard({
  total,
  onReview,
  onDismiss,
}: {
  total: number;
  onReview: () => void;
  onDismiss: () => void;
}) {
  const t = useT();
  return (
    <div className={styles.card}>
      <span className={styles.title}>{t((d) => d.gone.railTitle, { n: total })}</span>
      <span className={styles.line}>{t((d) => d.gone.railLine)}</span>
      <div className={styles.actions}>
        <button type="button" className={styles.go} onClick={onReview}>
          {t((d) => d.gone.railReview)}
        </button>
        <button type="button" className={styles.no} onClick={onDismiss}>
          {t((d) => d.gone.railNotNow)}
        </button>
      </div>
    </div>
  );
}
