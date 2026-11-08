// -- Framework Imports --
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { KeyboardEvent } from "react";
import { createPortal } from "react-dom";

// -- Component Imports --
import { Tooltip } from "../Tooltip/Tooltip";
import { MenuSidePanel } from "./MenuSidePanel";

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
 * quiet; destructive ones carry the warn tint. A list row with a `panel` opens a side panel beside the
 * menu on click, Enter or Right; Escape in the panel steps back to the row. Pair it with `useContextMenu`:
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
  forceFlip,
}: {
  topActions?: TopEntry[];
  items?: MenuEntry[];
  open: boolean;
  x: number;
  y: number;
  onClose: () => void;
  ariaLabel?: string;
  topActionsLabel?: string;
  /** Grows an axis back from (x, y) even when there is room: a menu hung from a trigger's edge. */
  forceFlip?: { x?: boolean; y?: boolean };
}) {
  const top = topActions ?? [];
  const list = items ?? [];
  const menuRef = useRef<HTMLDivElement | null>(null);
  const itemRefs = useRef<Array<HTMLButtonElement | null>>([]);
  const [coords, setCoords] = useState<{ left: number; top: number; origin: string } | null>(null);
  const [active, setActive] = useState(0);
  const menu = useMountTransition(open, EXIT_MS);
  const panelRef = useRef<HTMLDivElement | null>(null);
  // The row whose side panel is showing. It stays set after `open` drops so the panel exits with content.
  const [panel, setPanel] = useState<{ index: number; row: HTMLElement; open: boolean } | null>(null);

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
  // Placement waits on `mounted`, not just `open`: the mount transition flips `mounted` a render after
  // `open`, so the node (and its ref) only exist then - keying on `open` alone ran this before the menu
  // rendered and never re-ran, leaving coords stale or null (the menu stuck at 0,0, or the last spot).
  useLayoutEffect(() => {
    if (!open || !menu.mounted) return;
    const el = menuRef.current;
    if (!el) return;
    const r = el.getBoundingClientRect();
    const placed = placeMenu(
      { x, y },
      { width: r.width, height: r.height },
      { width: window.innerWidth, height: window.innerHeight },
      MARGIN,
      { x: forceFlip?.x, y: forceFlip?.y },
    );
    setCoords(placed);
  }, [open, x, y, menu.mounted, forceFlip?.x, forceFlip?.y]);

  // On open, start focus at the first enabled entry, once the menu has been placed and painted. Waits on
  // `mounted` too: the mount transition lands a render after `open`, and a frame that fires before it
  // would find no entry to focus.
  useEffect(() => {
    if (!open || !menu.mounted) return;
    setActive(0);
    setPanel(null);
    const frame = requestAnimationFrame(() => itemRefs.current[0]?.focus({ preventScroll: true }));
    return () => cancelAnimationFrame(frame);
  }, [open, menu.mounted]);

  // While open, a press or a scroll outside the menu and its panel, or losing the window, dismisses it.
  useEffect(() => {
    if (!open) return;
    const outside = (event: Event) => {
      const target = event.target as Node;
      return !menuRef.current?.contains(target) && !panelRef.current?.contains(target);
    };
    const onPointerDown = (event: PointerEvent) => {
      if (outside(event)) onClose();
    };
    const onScroll = (event: Event) => {
      if (outside(event)) onClose();
    };
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

  // The list index of the panel row at a focus position, or null for any other entry.
  const panelRowAt = (position: number) => {
    const slot = order[position];
    if (slot?.group !== "list") return null;
    const entry = list[slot.index];
    return !isSeparator(entry) && entry.panel ? slot.index : null;
  };

  const openPanel = (index: number) => {
    const at = focusIndexOf("list", index);
    const row = itemRefs.current[at];
    if (!row) return;
    setActive(at);
    setPanel({ index, row, open: true });
  };

  const back = () => {
    if (!panel) return;
    setPanel({ ...panel, open: false });
    const at = focusIndexOf("list", panel.index);
    setActive(at);
    itemRefs.current[at]?.focus({ preventScroll: true });
  };

  const togglePanel = (index: number) => {
    if (panel?.open && panel.index === index) back();
    else openPanel(index);
  };

  const selectAt = (position: number) => {
    const panelRow = panelRowAt(position);
    if (panelRow !== null) {
      togglePanel(panelRow);
      return;
    }
    const slot = order[position];
    if (!slot) return;
    const entry = slot.group === "top" ? top[slot.index] : list[slot.index];
    if (isSeparator(entry) || entry.disabled) return;
    entry.onSelect();
    onClose();
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>) => {
    // Keys stop here so the host never acts on them too (a row's own Enter). Chords pass on to the
    // shell, which swallows the webview's accelerators under a menu and keeps undo and redo.
    if (!event.ctrlKey && !event.metaKey) event.stopPropagation();
    switch (event.key) {
      case "ArrowRight": {
        event.preventDefault();
        const panelRow = panelRowAt(active);
        if (panelRow === null) focusAt(active + 1);
        else if (panel?.open && panel.index === panelRow) panelRef.current?.focus({ preventScroll: true });
        else openPanel(panelRow);
        break;
      }
      case "ArrowDown":
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
        aria-haspopup={entry.panel ? "dialog" : undefined}
        aria-expanded={entry.panel ? panel?.open === true && panel.index === index : undefined}
        tabIndex={focusIndex >= 0 && focusIndex === active ? 0 : -1}
        ref={(el) => {
          if (focusIndex >= 0) itemRefs.current[focusIndex] = el;
        }}
        onClick={() => {
          if (entry.disabled) return;
          if (entry.panel) {
            togglePanel(index);
            return;
          }
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

  const panelEntry = panel ? list[panel.index] : undefined;
  const panelContent =
    panel && panelEntry && !isSeparator(panelEntry) && panelEntry.panel ? (
      <MenuSidePanel
        open={open && panel.open}
        label={panelEntry.label}
        menuRef={menuRef}
        panelRef={panelRef}
        row={panel.row}
        onBack={back}
      >
        {panelEntry.panel({ close: onClose, back })}
      </MenuSidePanel>
    ) : null;

  const menuLayer = createPortal(
    <div
      ref={menuRef}
      role="menu"
      aria-label={ariaLabel}
      className={styles.menu}
      data-ready={coords ? "" : undefined}
      data-state={menu.state}
      style={{ left: coords?.left ?? 0, top: coords?.top ?? 0, transformOrigin: coords?.origin }}
      onKeyDown={onKeyDown}
      // A portal bubbles its events through the React tree, not the DOM, so a click on a menu item would
      // otherwise reach the onClick of whatever host rendered this menu (a card's own open handler, say),
      // firing a second unintended action. The menu is a self-contained surface: seal it here.
      onClick={(event) => event.stopPropagation()}
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

  return (
    <>
      {menuLayer}
      {panelContent}
    </>
  );
}
