// -- Framework Imports --
import { useEffect, useRef } from "react";
import type { RefObject } from "react";

// -- Utils Imports --
import { inTextEntry, menuOpen, modalOpen } from "../../../lib/keyScope";

/** What ambient mode does with its keys. */
export interface AmbientKeys {
  // The stage itself, which holds focus while no control does.
  stage: RefObject<HTMLElement | null>;
  onExit: () => void;
  onCycle: () => void;
  onTogglePlay: () => void;
  onWake: () => void;
}

/**
 * Binds ambient mode's keys while it is up: Escape exits and V cycles the visualizer, both caught ahead
 * of the app-wide shortcuts so Escape never also closes a pane underneath. Space on the stage itself
 * toggles playback even when the stage took focus from a keyboard entry, where the app-wide Space would
 * yield to it. Every other key wakes the chrome and passes on, so the playback shortcuts keep working. A
 * key a menu, a dialog or a field owns is left alone.
 */
export function useAmbientKeys(keys: AmbientKeys): void {
  const ref = useRef(keys);
  ref.current = keys;

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      const k = ref.current;
      k.onWake();
      if (inTextEntry(document.activeElement) || modalOpen() || menuOpen()) return;
      if (e.ctrlKey || e.metaKey || e.altKey) return;
      if (e.key === "Escape") {
        e.preventDefault();
        e.stopPropagation();
        k.onExit();
      } else if (e.key === "v" || e.key === "V") {
        e.preventDefault();
        e.stopPropagation();
        k.onCycle();
      } else if (e.key === " " && !e.shiftKey) {
        const active = document.activeElement;
        if (active !== k.stage.current && active !== document.body) return;
        e.preventDefault();
        e.stopPropagation();
        k.onTogglePlay();
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, []);
}
