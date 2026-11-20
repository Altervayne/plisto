// -- Component Imports --
import { QuietButton } from "../common/QuietButton";

// -- Utils Imports --
import { keptRowMeta } from "../../lib/keptBackupCopy";
import { expiryDays, keptRowKind } from "../../lib/keptBackups";
import { ageText } from "../../i18n/ageText";

// -- i18n Imports --
import { useT } from "../../i18n";

// -- Type Imports --
import type { KeptBackup } from "../../types";

// -- Style Imports --
import styles from "./KeptBackupRow.module.css";

/** A backup this close to expiring reads as a warning. */
const SOON_DAYS = 3;

/**
 * One kept backup: the trimmed file's title, what the trim did and where the original sits, the time it
 * has left, and the actions its state allows. A missing backup can only leave the list; a backup whose
 * file changed since the trim can only be discarded; a backup on an offline folder cannot be acted on.
 */
export function KeptBackupRow({
  backup,
  nowMs,
  disabled,
  onUndo,
  onDiscard,
  onRemove,
}: {
  backup: KeptBackup;
  nowMs: number;
  disabled: boolean;
  onUndo: () => void;
  onDiscard: () => void;
  onRemove: () => void;
}) {
  const t = useT();
  const kind = keptRowKind(backup);
  const days = expiryDays(backup, nowMs);
  const soon = days != null && days <= SOON_DAYS;

  const meta =
    kind === "missing"
      ? t((d) => d.fileWrites.kept.missingLine)
      : kind === "offline"
        ? t((d) => d.fileWrites.kept.offlineLine, { folder: backup.rootLabel })
        : keptRowMeta(t, backup, ageText(t, backup.keptAt, nowMs));
  const expiry =
    kind === "missing"
      ? null
      : days == null
        ? t((d) => d.fileWrites.kept.untilDiscard)
        : days === 0
          ? t((d) => d.fileWrites.kept.expiresToday)
          : t((d) => d.fileWrites.kept.expiresIn, { n: days });

  return (
    <div className={styles.row}>
      <div className={styles.text}>
        <span className={styles.title}>{backup.title}</span>
        <span className={styles.meta}>{meta}</span>
        <span className={styles.path}>{backup.relPath}</span>
      </div>
      <span className={soon ? `${styles.expiry} ${styles.soon}` : styles.expiry}>{expiry}</span>
      <span className={styles.actions}>
        {kind === "missing" ? (
          <>
            <span className={`${styles.pill} ${styles.warn}`}>{t((d) => d.fileWrites.kept.missingPill)}</span>
            <QuietButton onClick={onRemove} disabled={disabled}>
              {t((d) => d.fileWrites.kept.removeFromList)}
            </QuietButton>
          </>
        ) : null}
        {kind === "changed" ? (
          <span className={`${styles.pill} ${styles.warn}`}>{t((d) => d.fileWrites.kept.changedPill)}</span>
        ) : null}
        {kind === "offline" ? <span className={styles.pill}>{t((d) => d.fileWrites.kept.offlinePill)}</span> : null}
        {kind === "ready" ? (
          <QuietButton onClick={onUndo} disabled={disabled}>
            {t((d) => d.fileWrites.kept.undoTrim)}
          </QuietButton>
        ) : null}
        {kind !== "missing" ? (
          <QuietButton onClick={onDiscard} disabled={disabled || kind === "offline"}>
            {t((d) => d.fileWrites.kept.discard)}
          </QuietButton>
        ) : null}
      </span>
    </div>
  );
}
