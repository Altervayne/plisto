/*
 * The app-wide key map: one keydown plus where focus and the shell stand, resolved to the shortcut it
 * fires, or null to leave the key alone. Keys match on `key`, not `code`, so a shortcut follows the
 * printed key on any layout. Meta counts as Ctrl.
 */

/** A shortcut the shell carries out. `swallow` consumes the key and does nothing. */
export type ShortcutAction =
  | "finder"
  | "find"
  | "swallow"
  | "undo"
  | "redo"
  | "togglePlay"
  | "next"
  | "prev"
  | "seekForward"
  | "seekBack"
  | "volumeUp"
  | "volumeDown"
  | "selectAll"
  | "back"
  | "shortcuts";

/** The keydown fields the map reads. */
export interface ShortcutKey {
  key: string;
  ctrlKey: boolean;
  metaKey: boolean;
  shiftKey: boolean;
  altKey: boolean;
  defaultPrevented: boolean;
}

/** Where focus and the shell stand when the key lands. */
export interface ShortcutScope {
  // Focus sits in a text entry.
  typing: boolean;
  // A modal or a popup menu is open.
  overlay: boolean;
  // The Track Editor destination is showing with a session open.
  editorSession: boolean;
  // Focus sits on an element reached by keyboard.
  focusVisible: boolean;
  // The player is on and holds a track.
  playback: boolean;
  // An album or playlist full pane is open.
  canGoBack: boolean;
  // The current view registered a select-all.
  canSelectAll: boolean;
}

/**
 * Resolves a key to its shortcut. Ctrl+K and Ctrl+F reach through a field and are swallowed under an
 * overlay so the webview's own accelerators never fire. Undo and redo yield only to a field. Every other
 * shortcut yields to a field, an overlay, a key a surface already consumed, and Alt (AltGr arrives as
 * Ctrl+Alt). The workbench owns Space, the arrows and Escape while its session shows.
 */
export function resolveShortcut(e: ShortcutKey, scope: ShortcutScope): ShortcutAction | null {
  const mod = e.ctrlKey || e.metaKey;
  const key = e.key.length === 1 ? e.key.toLowerCase() : e.key;

  if (mod && key === "k") return scope.overlay ? "swallow" : "finder";
  if (mod && !e.shiftKey && !e.altKey && key === "f") return scope.overlay ? "swallow" : "find";
  if (scope.typing) return null;
  if (mod && key === "z" && !e.shiftKey) return "undo";
  if (mod && ((key === "z" && e.shiftKey) || key === "y")) return "redo";
  if (scope.overlay || e.defaultPrevented || e.altKey) return null;

  if (!mod && key === "?") return "shortcuts";
  if (mod && !e.shiftKey && key === "a") return scope.canSelectAll ? "selectAll" : null;
  if (scope.editorSession) return null;

  if (key === "Escape") return !mod && !e.shiftKey && scope.canGoBack ? "back" : null;
  if (!scope.playback) return null;

  if (key === " ") return !mod && !e.shiftKey && !scope.focusVisible ? "togglePlay" : null;
  if (mod && !e.shiftKey) {
    if (key === "ArrowRight") return "next";
    if (key === "ArrowLeft") return "prev";
    if (key === "ArrowUp") return "volumeUp";
    if (key === "ArrowDown") return "volumeDown";
  }
  if (e.shiftKey && !mod) {
    if (key === "ArrowRight") return "seekForward";
    if (key === "ArrowLeft") return "seekBack";
  }
  return null;
}
