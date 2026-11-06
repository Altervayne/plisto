// -- Framework Imports --
import { useRef, useState } from "react";
import type { MouseEvent } from "react";

// -- Library Imports --
import { ChevronDown, ChevronUp } from "lucide-react";

// -- Component Imports --
import { ContextMenu } from "../ContextMenu";
import { QuietButton } from "../QuietButton";

// -- i18n Imports --
import { useT } from "../../../i18n";

/** A second-step row: what a folded action with its own choices (a disc list) opens inside More. */
export interface MoreStep {
  label: string;
  onSelect: () => void;
}

/** One folded action as a menu row. `steps` makes it open a second menu instead of running. */
export interface MoreEntry {
  id: string;
  label: string;
  onSelect: () => void;
  disabled?: boolean;
  steps?: MoreStep[];
}

type Open = { level: "main" } | { level: "step"; steps: MoreStep[] };

/**
 * The trailing "More..." trigger of a folded bar, opening the shared context menu on the folded actions in
 * their bar order. `up` hangs the menu above the trigger (a bar floating at the bottom), otherwise below
 * it (a sticky bar at the top). A folded action with `steps` swaps to a second menu at the same anchor.
 * Escape, an outside press or a choice close it and return focus to the trigger when focus was inside.
 * `ghost` renders the bare trigger for width measurement.
 */
export function MoreMenu({
  entries,
  up,
  ghost = false,
}: {
  entries: MoreEntry[];
  up: boolean;
  ghost?: boolean;
}) {
  const t = useT();
  const triggerRef = useRef<HTMLButtonElement | null>(null);
  const [open, setOpen] = useState<Open | null>(null);
  const [anchor, setAnchor] = useState({ x: 0, y: 0 });
  // The menu closes itself on every select; a step choice must keep the flow open instead.
  const advancing = useRef(false);
  // The press that dismisses an open menu also lands on the trigger; remember it so the click does not
  // reopen what the press just closed.
  const pressedWhileOpen = useRef(false);

  const label = t((d) => d.common.more);
  const Chevron = up ? ChevronUp : ChevronDown;

  if (ghost) {
    return (
      <QuietButton tabIndex={-1}>
        {label}
        <Chevron size={14} strokeWidth={1.8} aria-hidden="true" />
      </QuietButton>
    );
  }

  const close = () => {
    if (advancing.current) {
      advancing.current = false;
      return;
    }
    const focused = document.activeElement;
    const insideMenu = focused instanceof HTMLElement && focused.closest('[role="menu"]') !== null;
    setOpen(null);
    if (insideMenu) triggerRef.current?.focus();
  };

  const toggle = (event: MouseEvent<HTMLButtonElement>) => {
    if (pressedWhileOpen.current) {
      pressedWhileOpen.current = false;
      return;
    }
    // The click carries the trigger: QuietButton takes no ref, and focus returns here on close.
    triggerRef.current = event.currentTarget;
    const rect = event.currentTarget.getBoundingClientRect();
    setAnchor({ x: rect.right, y: up ? rect.top - 8 : rect.bottom + 6 });
    setOpen({ level: "main" });
  };

  const mainItems = entries.map((entry) => ({
    label: entry.label,
    disabled: entry.disabled,
    onSelect: () => {
      const steps = entry.steps;
      if (steps) {
        advancing.current = true;
        setOpen({ level: "step", steps });
        return;
      }
      entry.onSelect();
    },
  }));

  const stepItems = open?.level === "step" ? open.steps : [];

  return (
    <>
      <QuietButton
        aria-haspopup="menu"
        aria-expanded={open !== null}
        onPointerDown={() => {
          pressedWhileOpen.current = open !== null;
        }}
        onClick={toggle}
      >
        {label}
        <Chevron size={14} strokeWidth={1.8} aria-hidden="true" />
      </QuietButton>
      <ContextMenu
        open={open?.level === "main"}
        x={anchor.x}
        y={anchor.y}
        onClose={close}
        ariaLabel={label}
        items={mainItems}
        forceFlip={{ x: true, y: up }}
      />
      <ContextMenu
        open={open?.level === "step"}
        x={anchor.x}
        y={anchor.y}
        onClose={close}
        ariaLabel={label}
        items={stepItems}
        forceFlip={{ x: true, y: up }}
      />
    </>
  );
}
