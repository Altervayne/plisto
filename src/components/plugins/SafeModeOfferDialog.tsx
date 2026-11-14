// -- Framework Imports --
import { useCallback } from "react";

// -- Component Imports --
import { ConfirmDialog } from "../common/ConfirmDialog/ConfirmDialog";

// -- i18n Imports --
import { useT } from "../../i18n";

// -- Style Imports --
import styles from "./SafeModeOfferDialog.module.css";

/**
 * The offer after an unclean exit with plugins serving: Plisto's own dialog, no plugin identity. The
 * choice is required, so Escape and the backdrop do nothing. `onAnswer(true)` starts without plugins,
 * `onAnswer(false)` starts normally; the confirm's own close also reports false, which the caller's gate
 * ignores once an answer is in.
 */
export function SafeModeOfferDialog({
  open,
  onAnswer,
}: {
  open: boolean;
  onAnswer: (safe: boolean) => void;
}) {
  const t = useT();
  const close = useCallback(() => onAnswer(false), [onAnswer]);
  return (
    <ConfirmDialog
      open={open}
      dismissable={false}
      accent
      title={t((d) => d.plugins.safeOffer.title)}
      prompt={t((d) => d.plugins.safeOffer.prompt)}
      confirmLabel={t((d) => d.plugins.safeOffer.startSafe)}
      cancelLabel={t((d) => d.plugins.safeOffer.startNormally)}
      onConfirm={() => onAnswer(true)}
      onClose={close}
    >
      <p className={styles.note}>{t((d) => d.plugins.safeOffer.note)}</p>
    </ConfirmDialog>
  );
}
