// -- Framework Imports --
import { useRef } from "react";

// -- Component Imports --
import { Toast } from "../common/Toast/Toast";
import { QuietButton } from "../common/QuietButton";

// -- State Imports --
import { useFileWritesRecovery, useFileWritesStore } from "../../state/fileWrites/store";

// -- Utils Imports --
import { revealFile } from "../../lib/opener";
import { recoveryLines } from "./recoveryLines";

// -- Type Imports --
import type { RecoveryReport } from "../../state/fileWrites/store";

// -- i18n Imports --
import { useT } from "../../i18n";

// -- Style Imports --
import styles from "./RecoveryToast.module.css";

/**
 * The notice after Plisto settled writes a closed app left unfinished. It stays until dismissed, and the
 * last report stays through the fade-out. Show reveals the first file that needs a look, when there is one.
 */
export function RecoveryToast() {
  const t = useT();
  const report = useFileWritesRecovery();
  const dismiss = useFileWritesStore((s) => s.dismissRecovery);
  const last = useRef<RecoveryReport | null>(null);

  if (report) last.current = report;
  const shown = report ?? last.current;
  if (!shown) return null;
  const file = shown.needsAttention[0];

  return (
    <Toast visible={report != null} className={styles.card}>
      <span className={styles.title}>{t((d) => d.fileWrites.recovery.title)}</span>
      {recoveryLines(t, shown).map((line) => (
        <p key={line} className={styles.line}>
          {line}
        </p>
      ))}
      <div className={styles.actions}>
        {file ? (
          <QuietButton onClick={() => void revealFile(file)}>{t((d) => d.fileWrites.recovery.show)}</QuietButton>
        ) : null}
        <QuietButton onClick={dismiss}>{t((d) => d.fileWrites.recovery.dismiss)}</QuietButton>
      </div>
    </Toast>
  );
}
