// -- Framework Imports --
import { useEffect, useRef } from "react";

/** Whether focus sits in a text entry, where the workbench shortcuts must not fire. */
function inTextEntry(el: Element | null): boolean {
  if (!(el instanceof HTMLElement)) return false;
  const tag = el.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || el.isContentEditable;
}

/** Whether a modal dialog is up, where its own keys (Escape, Enter, Space) must win over the shortcuts. */
function modalOpen(): boolean {
  return document.querySelector('[role="alertdialog"], [aria-modal="true"]') != null;
}

/**
 * The workbench editing-surface shortcuts. Tool and marker keys are optional so the cropper, which has
 * neither, drops them by leaving the callbacks out. Escape is progressive: clear a marker selection,
 * else stop a sounding preview, else fall through to the workbench close.
 */
export interface WorkbenchKeyMap {
  onMove?: () => void;
  onSplice?: () => void;
  onAddCut?: () => void;
  onRemoveSelected?: () => void;
  onPlaySelected?: () => void;
  hasSelection?: () => boolean;
  onDeselect?: () => void;
  onZoomIn?: () => void;
  onZoomOut?: () => void;
  onFit?: () => void;
  onTogglePreview: () => void;
  isSounding: () => boolean;
  onStopPreview: () => void;
  onClose: () => void;
}

/**
 * Binds the workbench shortcuts to the window while `active`. The live map rides a ref, so a preview
 * tick that rebuilds the callbacks never re-subscribes the listener. Events from a text entry pass
 * through untouched, so typing a title or a time is never hijacked.
 */
export function useWorkbenchKeys(active: boolean, map: WorkbenchKeyMap): void {
  const ref = useRef(map);
  ref.current = map;

  useEffect(() => {
    if (!active) return;
    const onKey = (e: KeyboardEvent) => {
      if (inTextEntry(document.activeElement) || modalOpen()) return;
      const m = ref.current;
      switch (e.key) {
        case "v":
        case "V":
          m.onMove?.();
          break;
        case "b":
        case "B":
          m.onSplice?.();
          break;
        case "m":
        case "M":
          if (m.onAddCut) {
            e.preventDefault();
            m.onAddCut();
          }
          break;
        case " ":
          e.preventDefault();
          m.onTogglePreview();
          break;
        // Shift gates the zoom keys, anchored to the playhead: Shift+= in, Shift+- out, Shift+0 fit.
        // Both the base and the shifted glyph are matched, so the layout's own symbol still lands.
        case "+":
        case "=":
          if (e.shiftKey && m.onZoomIn) {
            e.preventDefault();
            m.onZoomIn();
          }
          break;
        case "_":
        case "-":
          if (e.shiftKey && m.onZoomOut) {
            e.preventDefault();
            m.onZoomOut();
          }
          break;
        case ")":
        case "0":
          if (e.shiftKey && m.onFit) {
            e.preventDefault();
            m.onFit();
          }
          break;
        case "Delete":
        case "Backspace":
          m.onRemoveSelected?.();
          break;
        case "Enter":
          m.onPlaySelected?.();
          break;
        case "Escape":
          if (m.hasSelection?.()) {
            e.preventDefault();
            m.onDeselect?.();
          } else if (m.isSounding()) {
            e.preventDefault();
            m.onStopPreview();
          } else {
            m.onClose();
          }
          break;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [active]);
}
