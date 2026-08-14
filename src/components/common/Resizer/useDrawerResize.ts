// -- Framework Imports --
import { useCallback, useEffect, useRef, useState } from "react";
import type {
  KeyboardEvent as ReactKeyboardEvent,
  PointerEvent as ReactPointerEvent,
  RefObject,
} from "react";

// -- State Imports --
import { PREF_KEYS, usePreference, useSetPreference } from "../../../state/preferences/store";

// -- Type Imports --
import type { ResizerControl } from "./resizerTypes";

// -- Utils Imports --
import {
  clamp,
  DEFAULT_WIDTH,
  MAX_ABS,
  MIN_WIDTH,
  maxWidth,
  widthForDrag,
} from "./resizeGeometry";

// Discrete width change per arrow keypress, in pixels.
const KEY_STEP = 16;

/** The committed width, the container the caller lays out, and the resizer wired to both. */
export interface DrawerResize {
  width: number;
  containerRef: RefObject<HTMLDivElement | null>;
  resizer: ResizerControl;
}

/**
 * Drives the resizable right panel from the shared preference. The caller lays out
 * [content(flex:1), <Resizer/>, panel(flex:0 0 var(--drawer-width))] inside containerRef and sets
 * --drawer-width from the returned width, React-controlled at rest. A drag steers the var imperatively
 * so the fixed-width tiles never re-render mid-frame, then commits once on release; the store re-renders
 * with the same width, so the handoff shows no flash. Both library modes call this and share the one
 * persisted key, so resizing in one mode carries to the other.
 */
export function useDrawerResize(): DrawerResize {
  const stored = usePreference(PREF_KEYS.drawerWidth);
  const setPreference = useSetPreference();

  const parsed = stored != null ? parseInt(stored, 10) : NaN;
  const width = Number.isFinite(parsed) ? clamp(parsed, MIN_WIDTH, MAX_ABS) : DEFAULT_WIDTH;

  const containerRef = useRef<HTMLDivElement | null>(null);
  const dragRef = useRef<{ startX: number; startWidth: number; max: number } | null>(null);
  const latestWidthRef = useRef(width);

  const [dragging, setDragging] = useState(false);
  const [containerMax, setContainerMax] = useState(MAX_ABS);

  // The container-relative bound tracks the window, but never mid-drag: only the panel width changes
  // then, and the container row stays full width, so the observer stays quiet during a drag.
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const measure = () => setContainerMax(maxWidth(el.clientWidth));
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const onPointerDown = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>) => {
      const el = containerRef.current;
      if (!el) return;
      // Hold the pointer so a drag that leaves the handle keeps steering the width.
      e.preventDefault();
      e.currentTarget.setPointerCapture(e.pointerId);
      dragRef.current = { startX: e.clientX, startWidth: width, max: maxWidth(el.clientWidth) };
      latestWidthRef.current = width;
      setDragging(true);
    },
    [width],
  );

  const onPointerMove = useCallback((e: ReactPointerEvent<HTMLDivElement>) => {
    const start = dragRef.current;
    const el = containerRef.current;
    if (!start || !el) return;
    const w = widthForDrag(start.startWidth, e.clientX - start.startX, MIN_WIDTH, start.max);
    latestWidthRef.current = w;
    // Steer imperatively: no state write, so the fixed-width tiles hold still through the drag.
    el.style.setProperty("--drawer-width", `${w}px`);
  }, []);

  const onPointerUp = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>) => {
      if (!dragRef.current) return;
      dragRef.current = null;
      setDragging(false);
      if (e.currentTarget.hasPointerCapture(e.pointerId)) {
        e.currentTarget.releasePointerCapture(e.pointerId);
      }
      // Commit once: the store re-renders with the committed width and React re-applies the same var
      // over the imperative one, a seamless handoff.
      setPreference(PREF_KEYS.drawerWidth, String(latestWidthRef.current));
    },
    [setPreference],
  );

  const onKeyDown = useCallback(
    (e: ReactKeyboardEvent<HTMLDivElement>) => {
      const el = containerRef.current;
      if (!el) return;
      const max = maxWidth(el.clientWidth);
      // Left widens (the handle sits at the panel's left edge); Home/End jump to the value bounds.
      let next: number | null = null;
      if (e.key === "ArrowLeft") next = clamp(width + KEY_STEP, MIN_WIDTH, max);
      else if (e.key === "ArrowRight") next = clamp(width - KEY_STEP, MIN_WIDTH, max);
      else if (e.key === "Home") next = MIN_WIDTH;
      else if (e.key === "End") next = max;
      if (next === null) return;
      e.preventDefault();
      setPreference(PREF_KEYS.drawerWidth, String(next));
    },
    [width, setPreference],
  );

  return {
    width,
    containerRef,
    resizer: {
      dragging,
      valueNow: width,
      valueMin: MIN_WIDTH,
      valueMax: containerMax,
      onPointerDown,
      onPointerMove,
      onPointerUp,
      onKeyDown,
    },
  };
}
