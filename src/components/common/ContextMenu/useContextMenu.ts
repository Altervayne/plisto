// -- Framework Imports --
import { useCallback, useState } from "react";
import type { MouseEvent } from "react";

/** The captured menu state plus the two handlers a host wires: one to open at the pointer, one to close. */
export interface ContextMenuState {
  open: boolean;
  x: number;
  y: number;
  onContextMenu: (event: MouseEvent) => void;
  close: () => void;
}

/**
 * Captures a right-click and its pointer position for a `ContextMenu`. Spread `onContextMenu` on the
 * element that owns the menu; it suppresses the OS menu and records where to open. `open`, `x`, and
 * `y` feed straight into the component, and `close` dismisses it.
 */
export function useContextMenu(): ContextMenuState {
  const [state, setState] = useState({ open: false, x: 0, y: 0 });

  const onContextMenu = useCallback((event: MouseEvent) => {
    event.preventDefault();
    setState({ open: true, x: event.clientX, y: event.clientY });
  }, []);

  const close = useCallback(() => setState((prev) => ({ ...prev, open: false })), []);

  return { open: state.open, x: state.x, y: state.y, onContextMenu, close };
}
