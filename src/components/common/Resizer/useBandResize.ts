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
  BAND_DEFAULT,
  BAND_MAX_ABS,
  BAND_MIN,
  bandMaxHeight,
  clamp,
  sizeForDrag,
} from "./resizeGeometry";

// Discrete height change per arrow keypress, in pixels.
const KEY_STEP = 16;

/** The committed band height, the nav column the caller lays out, and the resizer wired to both. */
export interface BandResize {
  height: number;
  containerRef: RefObject<HTMLDivElement | null>;
  resizer: ResizerControl;
}

/**
 * Drives the resizable folder band from the shared preference. The caller sets --band-height on the
 * nav column (containerRef) from the returned height, React-controlled at rest, and lets the band cap
 * to it. A drag steers the var imperatively so the band never re-renders mid-frame, then commits once
 * on release; the store re-renders with the same height, so the handoff shows no flash. The nav column
 * both carries the var and supplies the clientHeight the nav-relative bound reads.
 */
export function useBandResize(): BandResize {
  const stored = usePreference(PREF_KEYS.bandHeight);
  const setPreference = useSetPreference();

  const parsed = stored != null ? parseInt(stored, 10) : NaN;
  const height = Number.isFinite(parsed) ? clamp(parsed, BAND_MIN, BAND_MAX_ABS) : BAND_DEFAULT;

  const containerRef = useRef<HTMLDivElement | null>(null);
  const dragRef = useRef<{ startY: number; startHeight: number; max: number } | null>(null);
  const latestHeightRef = useRef(height);

  const [dragging, setDragging] = useState(false);
  const [containerMax, setContainerMax] = useState(BAND_MAX_ABS);

  // The nav-relative bound tracks the column height, but never mid-drag: only the band cap changes
  // then, and the nav column keeps its own height, so the observer stays quiet during a drag.
  useEffect(() => {
    const el = containerRef.current;
    if (!el) return;
    const measure = () => setContainerMax(bandMaxHeight(el.clientHeight));
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const onPointerDown = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>) => {
      const el = containerRef.current;
      if (!el) return;
      // Hold the pointer so a drag that leaves the handle keeps steering the height.
      e.preventDefault();
      e.currentTarget.setPointerCapture(e.pointerId);
      dragRef.current = { startY: e.clientY, startHeight: height, max: bandMaxHeight(el.clientHeight) };
      latestHeightRef.current = height;
      setDragging(true);
    },
    [height],
  );

  const onPointerMove = useCallback((e: ReactPointerEvent<HTMLDivElement>) => {
    const start = dragRef.current;
    const el = containerRef.current;
    if (!start || !el) return;
    // The handle sits at the band's bottom edge, so a downward drag (positive deltaY) grows the cap.
    const h = sizeForDrag(start.startHeight, e.clientY - start.startY, BAND_MIN, start.max);
    latestHeightRef.current = h;
    // Steer imperatively: no state write, so the band holds still through the drag.
    el.style.setProperty("--band-height", `${h}px`);
  }, []);

  const onPointerUp = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>) => {
      if (!dragRef.current) return;
      dragRef.current = null;
      setDragging(false);
      if (e.currentTarget.hasPointerCapture(e.pointerId)) {
        e.currentTarget.releasePointerCapture(e.pointerId);
      }
      // Commit once: the store re-renders with the committed height and React re-applies the same var
      // over the imperative one, a seamless handoff.
      setPreference(PREF_KEYS.bandHeight, String(latestHeightRef.current));
    },
    [setPreference],
  );

  const onKeyDown = useCallback(
    (e: ReactKeyboardEvent<HTMLDivElement>) => {
      const el = containerRef.current;
      if (!el) return;
      const max = bandMaxHeight(el.clientHeight);
      // Down grows the band (the handle sits at its bottom edge); Home/End jump to the value bounds.
      let next: number | null = null;
      if (e.key === "ArrowDown") next = clamp(height + KEY_STEP, BAND_MIN, max);
      else if (e.key === "ArrowUp") next = clamp(height - KEY_STEP, BAND_MIN, max);
      else if (e.key === "Home") next = BAND_MIN;
      else if (e.key === "End") next = max;
      if (next === null) return;
      e.preventDefault();
      setPreference(PREF_KEYS.bandHeight, String(next));
    },
    [height, setPreference],
  );

  return {
    height,
    containerRef,
    resizer: {
      dragging,
      valueNow: height,
      valueMin: BAND_MIN,
      valueMax: containerMax,
      onPointerDown,
      onPointerMove,
      onPointerUp,
      onKeyDown,
    },
  };
}
