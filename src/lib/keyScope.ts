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

/** Whether a popup menu is open. Menus mount only while open, so presence is the signal. */
export function menuOpen(): boolean {
  return document.querySelector('[role="menu"]') != null;
}
