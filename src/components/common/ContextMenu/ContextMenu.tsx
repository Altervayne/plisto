// -- Framework Imports --
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { KeyboardEvent } from "react";
import { createPortal } from "react-dom";

// -- Component Imports --
import { Tooltip } from "../Tooltip/Tooltip";

// -- Hook Imports --
import { useMountTransition } from "../../../hooks/useMountTransition";

// -- Utils Imports --
import { placeMenu } from "./menuGeometry";
import { isSeparator } from "./contextMenuTypes";
import type { MenuEntry, TopEntry } from "./contextMenuTypes";

// -- Style Imports --
import styles from "./ContextMenu.module.css";

// Least clearance kept from every viewport edge when the menu is placed.
const MARGIN = 6;

// The menu's exit before it unmounts, matching --dur-fast on the exit keyframe.
const EXIT_MS = 120;

/** A focusable slot in roving order: which list it belongs to and its index within that list's array. */
interface Focus {
  group: "top" | "list";
  index: number;
}

/**
 * A premium right-click menu: an optional top bar of icon-only actions over an optional vertical list,
 * with separators allowed in either. It portals to the body, opens at the pointer through the shared
 * placement math (flipping near an edge so it always opens back into the screen), and dismisses on an
 * outside press, Escape, scroll, or blur. Focus rocks along the enabled entries with the arrows, Home
 * and End, Enter selects, and disabled entries are skipped but still announced. Neutral entries read
 * quiet; destructive ones carry the warn tint. Nothing consumes it yet; pair it with `useContextMenu`:
 *
 *   const menu = useContextMenu();
 *   <div onContextMenu={menu.onContextMenu} />
 *   <ContextMenu open={menu.open} x={menu.x} y={menu.y} onClose={menu.close}
 *     items={[{ icon: <Pencil />, label: t(...), onSelect: rename },
 *             { separator: true },
 *             { icon: <Trash2 />, label: t(...), onSelect: remove, style: "destructive" }]} />
 */
export function ContextMenu({
  topActions,
  items,
  open,
  x,
  y,
  onClose,
  ariaLabel,
  topActionsLabel,
}: {
  topActions?: TopEntry[];
  items?: MenuEntry[];
  open: boolean;
  x: number;
  y: number;
  onClose: () => void;
  ariaLabel?: string;
  topActionsLabel?: string;
}) {
  const top = topActions ?? [];
  const list = items ?? [];
  const menuRef = useRef<HTMLDivElement | null>(null);
  const itemRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const [coords, setCoords] = useState<{ left: number; top: number } | null>(null);
  const [active, setActive] = useState(0);
  const menu = useMountTransition(open, EXIT_MS);

  // The enabled entries, top bar first, in the order the arrows walk them.
  const order: Focus[] = [];
  top.forEach((entry, index) => {
    if (!isSeparator(entry) && !entry.disabled) order.push({ group: "top", index });
  });
  list.forEach((entry, index) => {
    if (!isSeparator(entry) && !entry.disabled) order.push({ group: "list", index });
  });
  const focusIndexOf = (group: "top" | "list", index: number) =>
    order.findIndex((slot) => slot.group === group && slot.index === index);

  // Measure the menu and place it before the browser paints, so it never flashes at the pointer origin.
  // The coords survive a close so the menu fades out where it sits; the next open re-measures at once.
  useLayoutEffect(() => {
    if (!open) return;
    const el = menuRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const placed = placeMenu(
      { x, y },
      { width: r.width, height: r.height },
      { width: window.innerWidth, height: window.innerHeight },
      MARGIN,
    );
    setCoords(placed);
  }, [open, x, y]);

  // On open, start focus at the first enabled entry, once the menu has been placed and painted.
  useEffect(() => {
    if (!open) return;
    setActive(0);
    const frame = requestAnimationFrame(() => itemRefs.current[0]?.focus({ preventScroll: true }));
    return () => cancelAnimationFrame(frame);
  }, [open]);

  // While open, an outside press, a scroll, or losing the window all dismiss it.
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!menuRef.current?.contains(event.target as Node)) onClose();
    };
    const onScroll = () => onClose();
    const onBlur = () => onClose();
    window.addEventListener("pointerdown", onPointerDown, true);
    window.addEventListener("scroll", onScroll, true);
    window.addEventListener("blur", onBlur);
    return () => {
      window.removeEventListener("pointerdown", onPointerDown, true);
      window.removeEventListener("scroll", onScroll, true);
      window.removeEventListener("blur", onBlur);
    };
  }, [open, onClose]);

  if (!menu.mounted) return null;

  const focusAt = (next: number) => {
    const n = order.length;
    if (n === 0) return;
    const wrapped = ((next % n) + n) % n;
    setActive(wrapped);
    itemRefs.current[wrapped]?.focus({ preventScroll: true });
  };

  const selectAt = (position: number) => {
    const slot = order[position];
    if (!slot) return;
    const entry = slot.group === "top" ? top[slot.index] : list[slot.index];
    if (isSeparator(entry) || entry.disabled) return;
    entry.onSelect();
    onClose();
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    switch (event.key) {
      case "ArrowDown":
      case "ArrowRight":
        event.preventDefault();
        focusAt(active + 1);
        break;
      case "ArrowUp":
      case "ArrowLeft":
        event.preventDefault();
        focusAt(active - 1);
        break;
      case "Home":
        event.preventDefault();
        focusAt(0);
        break;
      case "End":
        event.preventDefault();
        focusAt(order.length - 1);
        break;
      case "Enter":
      case " ":
        event.preventDefault();
        selectAt(active);
        break;
      case "Escape":
        event.preventDefault();
        onClose();
        break;
      case "Tab":
        onClose();
        break;
      default:
        break;
    }
  };

  const renderTop = (entry: TopEntry, index: number) => {
    if (isSeparator(entry)) {
      return <span key={`top-sep-${index}`} className={styles.vsep} role="separator" aria-orientation="vertical" />;
    }
    const focusIndex = focusIndexOf("top", index);
    const cls = entry.style === "destructive" ? `${styles.topbtn} ${styles.destructive}` : styles.topbtn;
    const button = (
      <button
        key={`top-${index}`}
        type="button"
        role="menuitem"
        className={cls}
        aria-label={entry.tooltip}
        aria-disabled={entry.disabled || undefined}
        tabIndex={focusIndex >= 0 && focusIndex === active ? 0 : -1}
        ref={(el) => {
          if (focusIndex >= 0) itemRefs.current[focusIndex] = el;
        }}
        onClick={() => {
          if (entry.disabled) return;
          entry.onSelect();
          onClose();
        }}
      >
        {entry.icon}
      </button>
    );
    return entry.tooltip ? (
      <Tooltip key={`top-${index}`} label={entry.tooltip}>
        {button}
      </Tooltip>
    ) : (
      button
    );
  };

  const renderItem = (entry: MenuEntry, index: number) => {
    if (isSeparator(entry)) {
      return <div key={`item-sep-${index}`} className={styles.hsep} role="separator" />;
    }
    const focusIndex = focusIndexOf("list", index);
    const cls = entry.style === "destructive" ? `${styles.item} ${styles.destructive}` : styles.item;
    const row = (
      <button
        key={`item-${index}`}
        type="button"
        role="menuitem"
        className={cls}
        aria-disabled={entry.disabled || undefined}
        tabIndex={focusIndex >= 0 && focusIndex === active ? 0 : -1}
        ref={(el) => {
          if (focusIndex >= 0) itemRefs.current[focusIndex] = el;
        }}
        onClick={() => {
          if (entry.disabled) return;
          entry.onSelect();
          onClose();
        }}
      >
        <span className={styles.icon} aria-hidden="true">
          {entry.icon}
        </span>
        <span className={styles.label}>{entry.label}</span>
      </button>
    );
    return entry.tooltip ? (
      <Tooltip key={`item-${index}`} label={entry.tooltip} placement="right">
        {row}
      </Tooltip>
    ) : (
      row
    );
  };

  return createPortal(
    <div
      ref={menuRef}
      role="menu"
      aria-label={ariaLabel}
      className={styles.menu}
      data-ready={coords ? "" : undefined}
      data-state={menu.state}
      style={{ left: coords?.left ?? 0, top: coords?.top ?? 0 }}
      onKeyDown={onKeyDown}
    >
      {top.length > 0 && (
        <div className={styles.topbar} role="group" aria-label={topActionsLabel}>
          {top.map((entry, index) => renderTop(entry, index))}
        </div>
      )}
      {list.length > 0 && <div className={styles.body}>{list.map((entry, index) => renderItem(entry, index))}</div>}
    </div>,
    document.body,
  );
}
