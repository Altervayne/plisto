// -- Component Imports --
import { PrimaryButton } from "../common/PrimaryButton";
import { QuietButton } from "../common/QuietButton";

// -- i18n Imports --
import { useT } from "../../i18n";

// -- Type Imports --
import type { ScopeState } from "./scopeState";

// -- Style Imports --
import styles from "./ExportView.module.css";

/**
 * The idle footer. Normally the one solid Export CTA, or its two-step confirm over a non-empty
 * destination. A destination with no record trades Export for marking it up to date, with a quiet way
 * back to a full export; one with nothing changed keeps Export dead and says what will show up.
 */
export function ExportActions({
  state,
  confirming,
  canExport,
  canAdopt,
  onExport,
  onConfirm,
  onCancelConfirm,
  onAdopt,
  onExportEverything,
}: {
  state: ScopeState;
  confirming: boolean;
  canExport: boolean;
  canAdopt: boolean;
  onExport: () => void;
  onConfirm: () => void;
  onCancelConfirm: () => void;
  onAdopt: () => void;
  onExportEverything: () => void;
}) {
  const t = useT();

  if (confirming) {
    return (
      <div className={styles.cta}>
        <div className={styles.confirm}>
          <span className={styles.warn}>{t((d) => d.export.nonEmpty)}</span>
          <div className={styles.confirmActions}>
            <PrimaryButton onClick={onConfirm}>{t((d) => d.export.confirm)}</PrimaryButton>
            <QuietButton onClick={onCancelConfirm}>{t((d) => d.export.cancel)}</QuietButton>
          </div>
        </div>
      </div>
    );
  }

  if (state === "noRecord") {
    return (
      <div className={styles.cta}>
        <PrimaryButton onClick={onAdopt} disabled={!canAdopt}>
          {t((d) => d.export.markUpToDate)}
        </PrimaryButton>
        <QuietButton onClick={onExportEverything}>
          {t((d) => d.export.exportEverythingInstead)}
        </QuietButton>
      </div>
    );
  }

  return (
    <div className={styles.cta}>
      <PrimaryButton onClick={onExport} disabled={!canExport}>
        {t((d) => d.export.action)}
      </PrimaryButton>
      {state === "nothingChanged" ? (
        <p className={styles.hint}>{t((d) => d.export.nothingHint)}</p>
      ) : null}
    </div>
  );
}
