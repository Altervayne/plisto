/*
 * Where keyboard focus sits, for the window-level shortcuts. A shortcut reads these before firing so it
 * never hijacks typing, and never steals a key a modal or an open menu owns.
 */

/** Whether focus sits in a text entry, where plain-key shortcuts must not fire. */
export function inTextEntry(el: Element | null): boolean {
  if (!(el instanceof HTMLElement)) return false;
  const tag = el.tagName;
  return tag === "INPUT" || tag === "TEXTAREA" || el.isContentEditable;
}

/** Whether a modal dialog is up, where its own keys (Escape, Enter, Space) must win over the shortcuts. */
export function modalOpen(): boolean {
  return document.querySelector('[role="alertdialog"], [aria-modal="true"]') != null;
}

/** The parts of an element and of the document `plistoSheetOpen` reads. */
interface ModalCandidate {
  getAttribute(name: string): string | null;
  hasAttribute(name: string): boolean;
}
interface ModalRoot {
  querySelectorAll(selector: string): ArrayLike<ModalCandidate>;
}

/**
 * Whether one of Plisto's own sheets is open. A plugin prompt carries `data-plugin-prompt` and does not
 * count, nor does a non-modal overlay marked `aria-modal="false"`.
 */
export function plistoSheetOpen(root: ModalRoot = document): boolean {
  return Array.from(root.querySelectorAll("[aria-modal]")).some(
    (el) => el.getAttribute("aria-modal") === "true" && !el.hasAttribute("data-plugin-prompt"),
  );
}

/** Whether a popup menu is open. Menus mount only while open, so presence is the signal. */
export function menuOpen(): boolean {
  return document.querySelector('[role="menu"]') != null;
}
