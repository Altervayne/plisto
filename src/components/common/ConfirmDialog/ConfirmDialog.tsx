// -- Framework Imports --
import { useEffect, useRef } from "react";
import type { ReactNode } from "react";
import { createPortal } from "react-dom";

// -- Style Imports --
import styles from "./ConfirmDialog.module.css";

/**
 * A quiet confirm over a dim scrim, portalled to the body: a prompt and a two-button choice. It exists
 * for a destructive, non-undoable action reached from a place that cannot hold the app's usual inline
 * two-step - a context menu that closes on select. Escape or a backdrop press cancels; focus lands on
 * Cancel so a stray Enter never confirms. `destructive` tints the confirm the danger red; `accent` fills
 * it with the accent for the one affirmative choice. An optional `title` heads the prompt, and an
 * optional `secondary` button sits between Cancel and the confirm, closing the dialog like them.
 * `children` sit between the prompt and the buttons for a choice or note that belongs to the decision;
 * `confirmDisabled` holds the confirm off while the decision cannot be carried out yet. `variant="plugin"`
 * draws a prompt that belongs to a plugin: an identity band on top, neutral buttons whatever `destructive`
 * and `accent` say, and a `data-plugin-prompt` mark so a plugin prompt is never taken for a Plisto sheet.
 * `dismissable={false}` makes the choice required: Escape and the backdrop do nothing, only a button answers.
 * `width="wide"` gives a sheet with a list room to breathe. `hideCancel` drops Cancel for a notice or a
 * result: the confirm then answers it, focus lands there, and a `secondary` button reads as the other
 * choice. An empty `prompt` leaves the line out.
 */
export function ConfirmDialog({
  open,
  title,
  prompt,
  confirmLabel,
  cancelLabel,
  onConfirm,
  onClose,
  destructive = false,
  accent = false,
  secondary,
  children,
  confirmDisabled = false,
  variant = "default",
  identity,
  dismissable = true,
  width = "default",
  hideCancel = false,
}: {
  open: boolean;
  title?: string;
  prompt: string;
  confirmLabel: string;
  cancelLabel: string;
  onConfirm: () => void;
  onClose: () => void;
  destructive?: boolean;
  accent?: boolean;
  secondary?: { label: string; onClick: () => void };
  children?: ReactNode;
  confirmDisabled?: boolean;
  variant?: "default" | "plugin";
  identity?: { icon: ReactNode; name: string; tag?: ReactNode; line: string };
  dismissable?: boolean;
  width?: "default" | "wide";
  hideCancel?: boolean;
}) {
  const cancelRef = useRef<HTMLButtonElement | null>(null);
  const confirmRef = useRef<HTMLButtonElement | null>(null);

  // The latest onClose, so a parent re-rendering with a fresh handler never re-runs the focus effect.
  const onCloseRef = useRef(onClose);
  onCloseRef.current = onClose;

  useEffect(() => {
    if (!open) return;
    (hideCancel ? confirmRef : cancelRef).current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape" && dismissable) onCloseRef.current();
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [open, dismissable, hideCancel]);

  if (!open) return null;

  const plugin = variant === "plugin";
  const text = (
    <>
      {title ? <h2 className={styles.title}>{title}</h2> : null}
      {prompt ? <p className={styles.prompt}>{prompt}</p> : null}
    </>
  );
  const content = (
    <>
      {plugin ? <div className={styles.pluginText}>{text}</div> : text}
      {children}
      <div className={styles.actions}>
        {hideCancel ? null : (
          <button ref={cancelRef} type="button" className={styles.cancel} onClick={onClose}>
            {cancelLabel}
          </button>
        )}
        {secondary ? (
          <button
            type="button"
            className={styles.secondary}
            onClick={() => {
              secondary.onClick();
              onClose();
            }}
          >
            {secondary.label}
          </button>
        ) : null}
        <button
          ref={confirmRef}
          type="button"
          className={`${styles.confirm} ${!plugin && destructive ? styles.destructive : ""} ${!plugin && accent ? styles.accent : ""}`}
          disabled={confirmDisabled}
          onClick={() => {
            onConfirm();
            onClose();
          }}
        >
          {confirmLabel}
        </button>
      </div>
    </>
  );

  return createPortal(
    // A portal bubbles its events through the React tree, not the DOM, so a click inside would otherwise
    // reach the onClick of whatever host rendered this dialog (a card's own open handler, say). Seal it so
    // cancelling or confirming never fires a second unintended action on the host.
    <div className={styles.overlay} onClick={(event) => event.stopPropagation()}>
      <div className={styles.backdrop} onClick={dismissable ? onClose : undefined} aria-hidden="true" />
      {plugin ? (
        <div
          className={`${styles.dialog} ${styles.plugin}`}
          role="alertdialog"
          aria-modal="true"
          aria-label={title ?? prompt}
          data-plugin-prompt=""
        >
          {identity ? (
            <div className={styles.band}>
              <span className={styles.tile}>{identity.icon}</span>
              <div className={styles.who}>
                <div className={styles.name}>
                  {identity.name}
                  {identity.tag}
                </div>
                <div className={styles.from}>{identity.line}</div>
              </div>
            </div>
          ) : null}
          <div className={styles.body}>{content}</div>
        </div>
      ) : (
        <div
          className={width === "wide" ? `${styles.dialog} ${styles.wide}` : styles.dialog}
          role="alertdialog"
          aria-modal="true"
          aria-label={title ?? prompt}
        >
          {content}
        </div>
      )}
    </div>,
    document.body,
  );
}
