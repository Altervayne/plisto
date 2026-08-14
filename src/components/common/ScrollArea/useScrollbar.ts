// -- Framework Imports --
import { useCallback, useEffect, useRef, useState } from "react";
import type { PointerEvent as ReactPointerEvent, RefObject } from "react";

// -- Utils Imports --
import { scrollDeltaForDrag, thumbGeometry } from "./scrollGeometry";
import type { ScrollMetrics, ThumbGeometry } from "./scrollGeometry";

// Smallest thumb the pointer can still grab, in pixels.
const MIN_THUMB = 28;

/** Everything the ScrollArea view needs: the element refs, the current thumb, and drag handlers. */
export interface Scrollbar {
  setViewport: (el: HTMLDivElement | null) => void;
  contentRef: RefObject<HTMLDivElement | null>;
  trackRef: RefObject<HTMLDivElement | null>;
  thumb: ThumbGeometry | null;
  dragging: boolean;
  onThumbPointerDown: (e: ReactPointerEvent<HTMLDivElement>) => void;
  onThumbPointerMove: (e: ReactPointerEvent<HTMLDivElement>) => void;
  onThumbPointerEnd: (e: ReactPointerEvent<HTMLDivElement>) => void;
}

/**
 * Wires a viewport's native scroll to the bespoke thumb. The viewport scrolls natively, so wheel,
 * touch, keyboard, and momentum are the engine's job; this only measures on scroll and on size
 * changes of both the viewport and its content, then reflects and steers scrollTop. The content box
 * is observed too, since virtualized rows grow it after mount. An optional external ref receives the
 * viewport element so a virtualizer can scroll the same surface.
 */
export function useScrollbar(externalViewportRef?: RefObject<HTMLDivElement | null>): Scrollbar {
  const [viewport, setViewportEl] = useState<HTMLDivElement | null>(null);
  const contentRef = useRef<HTMLDivElement | null>(null);
  const trackRef = useRef<HTMLDivElement | null>(null);
  const dragRef = useRef<{ pointerY: number; scrollTop: number } | null>(null);

  const [thumb, setThumb] = useState<ThumbGeometry | null>(null);
  const [dragging, setDragging] = useState(false);

  // Store the element in state so effects re-run when it mounts, and forward it to the parent.
  const setViewport = useCallback(
    (el: HTMLDivElement | null) => {
      setViewportEl(el);
      if (externalViewportRef) externalViewportRef.current = el;
    },
    [externalViewportRef],
  );

  const readMetrics = useCallback((): ScrollMetrics | null => {
    const track = trackRef.current;
    if (!viewport || !track) return null;
    return {
      viewport: viewport.clientHeight,
      content: viewport.scrollHeight,
      scroll: viewport.scrollTop,
      track: track.clientHeight,
      minThumb: MIN_THUMB,
    };
  }, [viewport]);

  const measure = useCallback(() => {
    const metrics = readMetrics();
    setThumb(metrics ? thumbGeometry(metrics) : null);
  }, [readMetrics]);

  useEffect(() => {
    if (!viewport) return;

    measure();
    viewport.addEventListener("scroll", measure, { passive: true });

    const observer = new ResizeObserver(measure);
    observer.observe(viewport);
    if (contentRef.current) observer.observe(contentRef.current);

    return () => {
      viewport.removeEventListener("scroll", measure);
      observer.disconnect();
    };
  }, [viewport, measure]);

  const onThumbPointerDown = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>) => {
      if (!viewport) return;
      // Hold the pointer so a drag that leaves the thumb keeps steering the scroll.
      e.preventDefault();
      e.currentTarget.setPointerCapture(e.pointerId);
      dragRef.current = { pointerY: e.clientY, scrollTop: viewport.scrollTop };
      setDragging(true);
    },
    [viewport],
  );

  const onThumbPointerMove = useCallback(
    (e: ReactPointerEvent<HTMLDivElement>) => {
      const start = dragRef.current;
      if (!start || !viewport) return;
      const metrics = readMetrics();
      if (!metrics) return;
      const delta = e.clientY - start.pointerY;
      viewport.scrollTop = start.scrollTop + scrollDeltaForDrag(delta, metrics);
    },
    [viewport, readMetrics],
  );

  const onThumbPointerEnd = useCallback((e: ReactPointerEvent<HTMLDivElement>) => {
    dragRef.current = null;
    setDragging(false);
    if (e.currentTarget.hasPointerCapture(e.pointerId)) {
      e.currentTarget.releasePointerCapture(e.pointerId);
    }
  }, []);

  return {
    setViewport,
    contentRef,
    trackRef,
    thumb,
    dragging,
    onThumbPointerDown,
    onThumbPointerMove,
    onThumbPointerEnd,
  };
}
