// -- Framework Imports --
import { useEffect, useId, useRef } from "react";
import { createPortal } from "react-dom";

// -- Component Imports --
import { BusyView } from "./BusyView";
import { CalmBody } from "./CalmBody";
import { HeavyBody } from "./HeavyBody";
import { NoticeView } from "./NoticeView";
import { ReviewActions } from "./ReviewActions";
import { SheetHeader } from "./SheetHeader";
import { UnsandboxedBody } from "./UnsandboxedBody";
import { ScrollArea } from "../../../common/ScrollArea/ScrollArea";

// -- State Imports --
import { useProbe } from "../../../../state/plugins/sandboxStore";

// -- Utils Imports --
import { variantOf } from "../../../../state/plugins/review";

// -- Type Imports --
import type { IconSource } from "../../../../state/plugins/iconCache";
import type { ReviewState, SheetState } from "../../../../state/plugins/sheet";

// -- Style Imports --
import styles from "./ReviewSheet.module.css";

const FOCUSABLE = 'button:not(:disabled), [role="checkbox"]:not(:disabled), [tabindex="0"]';

/** Where the open review's icon comes from: the staged files, or the installed plugin. */
function iconOf(state: ReviewState): IconSource {
  return state.token
    ? { kind: "staged", token: state.token }
    : { kind: "installed", id: state.subject.id, hash: state.hash ?? "" };
}

/** The variant body for the subject's tier and the sandbox check's live outcome. */
function VariantBody({ state }: { state: ReviewState }) {
  const variant = variantOf(state.subject, useProbe());
  const props = { subject: state.subject, mode: state.mode, lead: state.lead };
  if (variant === "heavy") return <HeavyBody {...props} />;
  if (variant === "unsandboxed") return <UnsandboxedBody {...props} />;
  return <CalmBody {...props} />;
}

/**
 * The plugins review sheet, on the confirm dialog's scrim and lifted card. Its content is plain data
 * (a review of a subject, or a notice), so it renders the same from an inspection or an installed row.
 * Escape and the scrim close it unless a command is running; focus starts on the safe button and stays
 * inside while open. The content comes from the calm, heavy or unsandboxed body by tier and probe.
 */
export function ReviewSheet({
  state,
  onConfirm,
  onClose,
}: {
  state: SheetState;
  onConfirm: (ticked: boolean) => void;
  onClose: () => void;
}) {
  const titleId = useId();
  const sheetRef = useRef<HTMLDivElement | null>(null);
  const opener = useRef<HTMLElement | null>(null);
  const busy = state.kind === "review" && state.phase !== "idle";
  // A reopened review (fresh manifest) is a new sheet: its tick must not carry over.
  const identity = state.kind === "review" ? `${state.mode}:${state.hash ?? state.token}` : "notice";

  useEffect(() => {
    opener.current = document.activeElement instanceof HTMLElement ? document.activeElement : null;
    return () => {
      if (opener.current?.isConnected) opener.current.focus();
    };
  }, []);

  useEffect(() => {
    const sheet = sheetRef.current;
    if (!sheet || busy) return;
    (sheet.querySelector<HTMLElement>("[data-autofocus]") ?? sheet).focus();
  }, [identity, busy]);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        if (!busy) onClose();
        return;
      }
      if (event.key !== "Tab") return;
      const sheet = sheetRef.current;
      if (!sheet) return;
      const nodes = Array.from(sheet.querySelectorAll<HTMLElement>(FOCUSABLE));
      const active = document.activeElement;
      const first = nodes[0];
      const last = nodes[nodes.length - 1];
      if (!first || !sheet.contains(active)) {
        event.preventDefault();
        (first ?? sheet).focus();
      } else if (event.shiftKey && (active === first || active === sheet)) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && active === last) {
        event.preventDefault();
        first.focus();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [busy, onClose]);

  return createPortal(
    <div className={styles.overlay}>
      <div className={styles.backdrop} onClick={busy ? undefined : onClose} aria-hidden="true" />
      <div
        ref={sheetRef}
        className={styles.sheet}
        role="dialog"
        aria-modal="true"
        aria-labelledby={titleId}
        tabIndex={-1}
      >
        {state.kind === "notice" ? (
          <NoticeView state={state} titleId={titleId} onClose={onClose} />
        ) : busy ? (
          <BusyView name={state.subject.name} mode={state.mode} phase={state.phase} titleId={titleId} />
        ) : (
          <>
            <SheetHeader subject={state.subject} icon={iconOf(state)} titleId={titleId} />
            <ScrollArea className={styles.area} edgeFade>
              <VariantBody state={state} />
            </ScrollArea>
            <ReviewActions
              key={identity}
              subject={state.subject}
              mode={state.mode}
              onConfirm={onConfirm}
              onCancel={onClose}
            />
          </>
        )}
      </div>
    </div>,
    document.body,
  );
}
