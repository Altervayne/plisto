// -- Framework Imports --
import { useEffect, useRef } from "react";

// -- State Imports --
import { usePlayerStore } from "../../state/player/store";
import { SEEK_STEP, VOLUME_STEP, nudgeSeek, nudgeVolume } from "../../state/player/nudge";
import { activeViewKeys } from "../../state/shell/viewKeys";

// -- Utils Imports --
import { inTextEntry, menuOpen, modalOpen } from "../../lib/keyScope";
import { resolveShortcut } from "./resolveShortcut";

/** What the shell knows and does for the app-wide keys. */
export interface ShellShortcuts {
  finderEnabled: boolean;
  openFinder: () => void;
  undo: () => void;
  redo: () => void;
  // Closes the open album or playlist full pane; null when none is open.
  onBack: (() => void) | null;
  // The Track Editor destination is showing with a session open.
  editorSession: boolean;
  // False while the current view's registration sits hidden under a full pane.
  viewKeysLive: boolean;
  playerEnabled: boolean;
  openShortcuts: () => void;
}

/** Whether focus sits on an element reached by keyboard, which keeps Space for itself. */
function keyboardFocused(el: Element | null): boolean {
  return el instanceof HTMLElement && el !== document.body && el.matches(":focus-visible");
}

/**
 * Binds the app-wide shortcuts to the window for the shell's life. The shell's state rides a ref, so
 * the listener binds once and stays ahead of every surface that opens later: a dialog's own Escape
 * handler always runs after this one, which finds the dialog still open. Playback reads the player store
 * at key time, so the shell never subscribes to the status tick.
 */
export function useShellShortcuts(shell: ShellShortcuts): void {
  const ref = useRef(shell);
  ref.current = shell;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const s = ref.current;
      const active = document.activeElement;
      const { status, actions } = usePlayerStore.getState();
      const view = s.viewKeysLive ? activeViewKeys() : null;
      const action = resolveShortcut(e, {
        typing: inTextEntry(active),
        overlay: modalOpen() || menuOpen(),
        editorSession: s.editorSession,
        focusVisible: keyboardFocused(active),
        playback: s.playerEnabled && status.track_id != null,
        canGoBack: s.onBack != null,
        canSelectAll: view?.selectAll != null,
      });
      if (action == null) return;
      e.preventDefault();

      switch (action) {
        case "swallow":
          break;
        case "finder":
          if (s.finderEnabled) s.openFinder();
          break;
        case "find":
          if (view?.focusSearch) view.focusSearch();
          else if (s.finderEnabled) s.openFinder();
          break;
        case "undo":
          s.undo();
          break;
        case "redo":
          s.redo();
          break;
        case "togglePlay":
          actions.toggle();
          break;
        case "next":
          actions.next();
          break;
        case "prev":
          actions.prev();
          break;
        case "seekForward":
        case "seekBack": {
          const delta = action === "seekForward" ? SEEK_STEP : -SEEK_STEP;
          const secs = nudgeSeek(status.position_secs, status.duration_secs, delta);
          if (secs != null) actions.seek(secs);
          break;
        }
        case "volumeUp":
          actions.setVolume(nudgeVolume(status.volume, VOLUME_STEP));
          break;
        case "volumeDown":
          actions.setVolume(nudgeVolume(status.volume, -VOLUME_STEP));
          break;
        case "selectAll":
          view?.selectAll?.();
          break;
        case "back":
          s.onBack?.();
          break;
        case "shortcuts":
          s.openShortcuts();
          break;
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, []);
}
