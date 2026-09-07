/*
 * The window's OS file-drop, gated to a surface that queues. Tauri captures the OS drag-drop at the
 * webview level, so a file dragged from the desktop arrives here, not as an HTML5 DOM drop. `enabled`
 * scopes it to the player so a drop never lands where it is not a queue target; the internal HTML5
 * row-reorder drags carry no files and are untouched. A no-op where the webview is absent.
 */

// -- Framework Imports --
import { useEffect, useState } from "react";

// -- Library Imports --
import { getCurrentWebview } from "@tauri-apps/api/webview";

// -- Local Imports --
import { keepAudioFiles } from "../lib/audioFiles";

/**
 * Subscribes to the current webview's file drops while `enabled`, returning whether a drag is over the
 * window. `onDrop` receives playable audio paths only, so a non-audio drop never pokes the engine. Keep
 * `onDrop` stable so the listener is not re-bound each render.
 */
export function useFileDrop(enabled: boolean, onDrop: (paths: string[]) => void): boolean {
  const [dragging, setDragging] = useState(false);

  useEffect(() => {
    if (!enabled) {
      setDragging(false);
      return;
    }

    let alive = true;
    let unlisten: (() => void) | undefined;

    let webview;
    try {
      webview = getCurrentWebview();
    } catch {
      // No desktop runtime (a plain browser preview): nothing to listen to.
      return;
    }

    void webview
      .onDragDropEvent((event) => {
        const payload = event.payload;
        if (payload.type === "enter" || payload.type === "over") {
          setDragging(true);
        } else if (payload.type === "leave") {
          setDragging(false);
        } else if (payload.type === "drop") {
          setDragging(false);
          const audio = keepAudioFiles(payload.paths);
          if (audio.length > 0) onDrop(audio);
        }
      })
      .then((fn) => {
        if (alive) unlisten = fn;
        else fn();
      })
      .catch(() => {});

    return () => {
      alive = false;
      setDragging(false);
      unlisten?.();
    };
  }, [enabled, onDrop]);

  return dragging;
}
