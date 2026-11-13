/*
 * Tracks where a slot element sits inside a container, in the container's own coordinates. The frame
 * layer positions the shown frame with it. It re-measures when either element resizes, when the window
 * resizes and when the slot changes, and keeps the same object while the numbers are unchanged.
 */

// -- Framework Imports --
import { useLayoutEffect, useState } from "react";

// -- Type Imports --
import type { FrameRect } from "./wrapperView";

const same = (a: FrameRect | null, b: FrameRect | null) =>
  a === b ||
  (a != null &&
    b != null &&
    a.top === b.top &&
    a.left === b.left &&
    a.width === b.width &&
    a.height === b.height);

/** The slot's rect relative to the container, or null while either element is missing. */
export function useTrackedRect(slot: HTMLElement | null, container: HTMLElement | null): FrameRect | null {
  const [rect, setRect] = useState<FrameRect | null>(null);

  useLayoutEffect(() => {
    if (!slot || !container) {
      setRect(null);
      return;
    }
    const measure = () => {
      const s = slot.getBoundingClientRect();
      const c = container.getBoundingClientRect();
      const next = { top: s.top - c.top, left: s.left - c.left, width: s.width, height: s.height };
      setRect((prev) => (same(prev, next) ? prev : next));
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(slot);
    observer.observe(container);
    window.addEventListener("resize", measure);
    return () => {
      observer.disconnect();
      window.removeEventListener("resize", measure);
    };
  }, [slot, container]);

  return rect;
}
