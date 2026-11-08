/*
 * The side panel a context-menu row opens: the menu's surface beside the menu, holding caller content.
 * It portals on its own as a sibling of the menu, never inside it: the menu's enter transform would make
 * the menu the containing block of a fixed child and trap the panel within it. It hides by opacity, not
 * visibility, until placed, so its content can take focus on mount.
 */

// -- Framework Imports --
import { useEffect, useLayoutEffect, useState } from "react";
import type { KeyboardEvent, ReactNode, RefObject } from "react";
import { createPortal } from "react-dom";

// -- Hook Imports --
import { useMountTransition } from "../../../hooks/useMountTransition";

// -- Utils Imports --
import { placeBeside } from "./menuGeometry";
import type { Point } from "./menuGeometry";

// -- Style Imports --
import styles from "./ContextMenu.module.css";

// Least clearance kept from the viewport edges when the panel is placed.
const MARGIN = 8;

// The panel's exit before it unmounts, matching --dur-fast on the exit keyframe.
const EXIT_MS = 120;

/**
 * Places the panel beside `menuRef` level with `row`, and re-places it whenever its content resizes.
 * Focus moves into the panel on open; content that focuses its own first entry on mount keeps it.
 * Escape calls `onBack`. Clicks and plain keys are sealed here so they never reach the menu's host.
 */
export function MenuSidePanel({
  open,
  label,
  menuRef,
  panelRef,
  row,
  onBack,
  children,
}: {
  open: boolean;
  label: string;
  menuRef: RefObject<HTMLDivElement | null>;
  panelRef: RefObject<HTMLDivElement | null>;
  row: HTMLElement;
  onBack: () => void;
  children: ReactNode;
}) {
  const [coords, setCoords] = useState<Point | null>(null);
  const panel = useMountTransition(open, EXIT_MS);

  useLayoutEffect(() => {
    if (!open || !panel.mounted) return;
    const el = panelRef.current;
    const menuEl = menuRef.current;
    if (!el || !menuEl) return;
    const place = () =>
      setCoords(
        placeBeside(
          menuEl.getBoundingClientRect(),
          row.getBoundingClientRect(),
          { width: el.offsetWidth, height: el.offsetHeight },
          { width: window.innerWidth, height: window.innerHeight },
          MARGIN,
        ),
      );
    place();
    const observer = new ResizeObserver(place);
    observer.observe(el);
    return () => observer.disconnect();
  }, [open, panel.mounted, menuRef, panelRef, row]);

  // A frame later, so content focusing itself on mount has already done so.
  useEffect(() => {
    if (!open || !panel.mounted) return;
    const frame = requestAnimationFrame(() => {
      const el = panelRef.current;
      if (el && !el.contains(document.activeElement)) el.focus({ preventScroll: true });
    });
    return () => cancelAnimationFrame(frame);
  }, [open, panel.mounted, panelRef]);

  if (!panel.mounted) return null;

  // Sealed like the menu's keys: chords still reach the shell.
  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    if (!event.ctrlKey && !event.metaKey) event.stopPropagation();
    if (event.key !== "Escape") return;
    event.preventDefault();
    onBack();
  };

  return createPortal(
    <div
      ref={panelRef}
      role="dialog"
      aria-label={label}
      tabIndex={-1}
      className={styles.panel}
      data-ready={coords ? "" : undefined}
      data-state={panel.state}
      style={{ left: coords?.x ?? 0, top: coords?.y ?? 0 }}
      onKeyDown={onKeyDown}
      onClick={(event) => event.stopPropagation()}
    >
      {children}
    </div>,
    document.body,
  );
}
