// -- Framework Imports --
import { useState } from "react";

// -- Component Imports --
import { CheckRow } from "../../../plugins/CheckRow";

// -- State Imports --
import { useProbe } from "../../../../state/plugins/sandboxStore";

// -- Utils Imports --
import { canConfirm, isCompatible, needsTick } from "../../../../state/plugins/review";

// -- i18n Imports --
import { useT } from "../../../../i18n";

// -- Type Imports --
import type { ReviewMode, ReviewSubject } from "../../../../state/plugins/review";

// -- Style Imports --
import styles from "./ReviewSheet.module.css";

/**
 * The foot of a review: the "I understand" tick where the confirm turns the plugin on and the variant
 * is not calm, for an install over leftover saved data the note and the clear-data tick (off by default), a line saying what the confirm does, and Cancel beside the confirm. The confirm stays
 * off until the tick is set, and for a plugin this Plisto cannot run. Focus starts on Cancel.
 */
export function ReviewActions({
  subject,
  mode,
  onConfirm,
  onCancel,
}: {
  subject: ReviewSubject;
  mode: ReviewMode;
  onConfirm: (ticked: boolean, clearData: boolean) => void;
  onCancel: () => void;
}) {
  const t = useT();
  const [ticked, setTicked] = useState(false);
  const [clearData, setClearData] = useState(false);
  const leftover = mode === "install" && subject.leftoverData;
  const probe = useProbe();
  const tick = needsTick(subject, mode, probe);
  const compatible = isCompatible(subject);
  const minVersion = subject.compat.state === "needs_newer" ? subject.compat.min_plisto : "";

  return (
    <div className={styles.footer}>
      {leftover ? (
        <>
          <p className={styles.note}>{t((d) => d.plugins.sheet.leftoverNote)}</p>
          <CheckRow checked={clearData} onChange={setClearData} label={t((d) => d.plugins.sheet.leftoverClear)} />
        </>
      ) : null}
      {tick ? (
        <CheckRow checked={ticked} onChange={setTicked} label={t((d) => d.plugins.sheet.understand)} />
      ) : null}
      {!compatible ? (
        <p className={`${styles.note} ${styles.warnNote}`}>
          {t((d) => d.plugins.sheet.incompatible, { version: minVersion })}
        </p>
      ) : mode === "install" ? (
        <p className={styles.note}>{t((d) => d.plugins.sheet.offNote)}</p>
      ) : mode === "update" ? (
        <p className={styles.note}>{t((d) => d.plugins.sheet.updateNote)}</p>
      ) : null}
      <div className={styles.actions}>
        <button type="button" className={styles.cancel} data-autofocus onClick={onCancel}>
          {mode === "consent" ? t((d) => d.plugins.sheet.keepOff) : t((d) => d.plugins.sheet.cancel)}
        </button>
        <button
          type="button"
          className={styles.confirm}
          disabled={!canConfirm(subject, mode, ticked, false, probe)}
          onClick={() => onConfirm(ticked, leftover && clearData)}
        >
          {mode === "install"
            ? t((d) => d.plugins.sheet.install)
            : mode === "update"
              ? t((d) => d.plugins.sheet.update)
              : t((d) => d.plugins.sheet.approve)}
        </button>
      </div>
    </div>
  );
}
