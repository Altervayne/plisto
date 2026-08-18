// -- Framework Imports --
import { cloneElement, useCallback, useEffect, useId, useLayoutEffect, useRef, useState } from "react";
import type { FocusEvent, HTMLAttributes, ReactElement, ReactNode, Ref } from "react";
import { createPortal } from "react-dom";

// -- Hook Imports --
import { useMountTransition } from "../../../hooks/useMountTransition";

// -- Utils Imports --
import { placeTooltip } from "./tooltipGeometry";
import type { TooltipPlacement } from "./tooltipGeometry";

// -- Style Imports --
import styles from "./Tooltip.module.css";

// Hover dwell before the bubble appears; a keyboard focus shows it at once, no dwell.
const DELAY = 450;
// Distance from the trigger, and the least clearance kept from every viewport edge.
const GAP = 8;
const MARGIN = 6;
// The bubble's exit before it unmounts, matching --dur-fast on the exit keyframe.
const EXIT_MS = 120;

/** The subset of the trigger's props the tooltip reads or wraps: its ref and the handlers it composes with. */
type TriggerProps = HTMLAttributes<HTMLElement> & { ref?: Ref<HTMLElement> };

/** Threads a value through both the tooltip's own ref and whatever ref the trigger already carried. */
function applyRef(ref: Ref<HTMLElement> | undefined, node: HTMLElement | null): void {
  if (typeof ref === "function") ref(node);
  else if (ref) (ref as { current: HTMLElement | null }).current = node;
}

/** Runs the trigger's existing handler, then ours, so wrapping never drops what the child already did. */
function compose<E>(theirs: ((event: E) => void) | undefined, ours: (event: E) => void): (event: E) => void {
  return (event) => {
    theirs?.(event);
    ours(event);
  };
}

/**
 * A calm replacement for the native `title`: a portal bubble that reads over any surface. It shows on
 * hover after a short dwell and at once on keyboard focus, and hides on leave, blur, Escape, or scroll.
 * The trigger is the child itself - the label clones it to add a ref and the reveal handlers rather than
 * a wrapper, so it never disturbs a grid cell or a drag handle. The bubble portals to the body so it
 * escapes clipping and stacking contexts, is measured then flipped and clamped into the viewport, and
 * carries `role="tooltip"` wired to the trigger by `aria-describedby`. It never eats the pointer.
 */
export function Tooltip({
  label,
  placement = "top",
  children,
}: {
  label: ReactNode;
  placement?: TooltipPlacement;
  children: ReactElement<TriggerProps>;
}) {
  const id = useId();
  const triggerRef = useRef<HTMLElement | null>(null);
  const bubbleRef = useRef<HTMLDivElement | null>(null);
  const timer = useRef<number | null>(null);
  const [open, setOpen] = useState(false);
  const [coords, setCoords] = useState<{ left: number; top: number } | null>(null);
  const bubble = useMountTransition(open, EXIT_MS);

  // Keep the child's own ref working while measuring the trigger, through a stable callback so the
  // wrapping never churns the ref on every render.
  const savedChildRef = useRef(children.props.ref);
  savedChildRef.current = children.props.ref;
  const setTrigger = useCallback((node: HTMLElement | null) => {
    triggerRef.current = node;
    applyRef(savedChildRef.current, node);
  }, []);

  const clearTimer = () => {
    if (timer.current != null) {
      clearTimeout(timer.current);
      timer.current = null;
    }
  };
  const scheduleShow = () => {
    clearTimer();
    timer.current = window.setTimeout(() => setOpen(true), DELAY);
  };
  const showNow = () => {
    clearTimer();
    setOpen(true);
  };
  const hide = () => {
    clearTimer();
    setOpen(false);
  };

  // A pointer press that lands focus should not fire the bubble; only a real keyboard focus does.
  const onFocusTrigger = (event: FocusEvent<HTMLElement>) => {
    if (event.currentTarget.matches(":focus-visible")) showNow();
  };

  // Measure the trigger and the bubble, then place it before the browser paints so it never flashes
  // at the wrong spot. The coords survive a close so the bubble fades out where it sits; the next open
  // re-measures.
  useLayoutEffect(() => {
    if (!open) return;
    const trigger = triggerRef.current;
    const bubble = bubbleRef.current;
    if (!trigger || !bubble) return;
    const t = trigger.getBoundingClientRect();
    const b = bubble.getBoundingClientRect();
    const placed = placeTooltip(
      { top: t.top, left: t.left, width: t.width, height: t.height },
      { width: b.width, height: b.height },
      { width: window.innerWidth, height: window.innerHeight },
      placement,
      GAP,
      MARGIN,
    );
    setCoords({ left: placed.left, top: placed.top });
    // `bubble.mounted` is a dependency because the bubble mounts a render AFTER `open` flips (its own
    // mount transition defers it): without it this effect runs once while bubbleRef is still null, bails,
    // and never re-runs - leaving the bubble unpositioned and stuck at visibility:hidden.
  }, [open, bubble.mounted, placement, label]);

  // While open, any scroll, resize, or Escape dismisses it; the bubble is anchored, not tracked.
  useEffect(() => {
    if (!open) return;
    const dismiss = () => hide();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === "Escape") hide();
    };
    window.addEventListener("scroll", dismiss, true);
    window.addEventListener("resize", dismiss);
    window.addEventListener("keydown", onKey);
    return () => {
      window.removeEventListener("scroll", dismiss, true);
      window.removeEventListener("resize", dismiss);
      window.removeEventListener("keydown", onKey);
    };
  }, [open]);

  useEffect(() => () => clearTimer(), []);

  const enabled = label != null && label !== "";
  const trigger = cloneElement(children, {
    ref: setTrigger,
    "aria-describedby": open && enabled ? id : children.props["aria-describedby"],
    onPointerEnter: compose(children.props.onPointerEnter, scheduleShow),
    onPointerLeave: compose(children.props.onPointerLeave, hide),
    onFocus: compose(children.props.onFocus, onFocusTrigger),
    onBlur: compose(children.props.onBlur, hide),
  });

  if (!enabled) return children;

  return (
    <>
      {trigger}
      {bubble.mounted &&
        createPortal(
          <div
            ref={bubbleRef}
            id={id}
            role="tooltip"
            className={styles.bubble}
            data-ready={coords ? "" : undefined}
            data-state={bubble.state}
            style={{ left: coords?.left ?? 0, top: coords?.top ?? 0 }}
          >
            {label}
          </div>,
          document.body,
        )}
    </>
  );
}
