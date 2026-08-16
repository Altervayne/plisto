// -- Framework Imports --
import { useEffect, useRef } from "react";
import { createPortal } from "react-dom";

// -- Style Imports --
import styles from "./ConfirmDialog.module.css";

/**
 * A quiet confirm over a dim scrim, portalled to the body: a prompt and a two-button choice. It exists
 * for a destructive, non-undoable action reached from a place that cannot hold the app's usual inline
 * two-step - a context menu that closes on select. Escape or a backdrop press cancels; focus lands on
 * Cancel so a stray Enter never confirms. `destructive` tints the confirm the danger red.
 */
export function ConfirmDialog({
  open,
  prompt,
  confirmLabel,
  cancelLabel,
  onConfirm,
  onClose,
  destructive = false,
}: {
  open: boolean;
  prompt: string;
  confirmLabel: string;
  cancelLabel: string;
  onConfirm: () => void;
  onClose: () => void;
  destructive?: boolean;
}) {
  const cancelRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    if (!open) return;
    cancelRef.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, onClose]);

  if (!open) return null;

  return createPortal(
    // A portal bubbles its events through the React tree, not the DOM, so a click inside would otherwise
    // reach the onClick of whatever host rendered this dialog (a card's own open handler, say). Seal it so
    // cancelling or confirming never fires a second unintended action on the host.
    <div className={styles.overlay} onClick={(event) => event.stopPropagation()}>
      <div className={styles.backdrop} onClick={onClose} aria-hidden="true" />
      <div className={styles.dialog} role="alertdialog" aria-modal="true" aria-label={prompt}>
        <p className={styles.prompt}>{prompt}</p>
        <div className={styles.actions}>
          <button ref={cancelRef} type="button" className={styles.cancel} onClick={onClose}>
            {cancelLabel}
          </button>
          <button
            type="button"
            className={`${styles.confirm} ${destructive ? styles.destructive : ""}`}
            onClick={() => {
              onConfirm();
              onClose();
            }}
          >
            {confirmLabel}
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
