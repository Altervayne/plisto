// -- Framework Imports --
import { useEffect } from "react";
import type { RefObject } from "react";

// -- Local Imports --
import { easeStep, wheelStep } from "./stripMath";

/**
 * Turns the vertical wheel into horizontal travel on the strip at `stripRef`: a notch eases one tile on,
 * a trackpad moves 1:1, and a sideways swipe stays native. The listener is non-passive so it can keep the
 * page from scrolling. The ease tracks its own offset rather than reading scrollLeft back, which rounds,
 * so it always lands. A reduced-motion preference jumps a notch at once.
 */
export function useStripWheel(stripRef: RefObject<HTMLElement | null>): void {
  useEffect(() => {
    const strip = stripRef.current;
    if (!strip) return;
    let target: number | null = null;
    let at = 0;
    let raf = 0;

    const stop = () => {
      cancelAnimationFrame(raf);
      raf = 0;
      target = null;
    };
    const frame = () => {
      if (target == null) return;
      at = easeStep(at, target);
      strip.scrollLeft = at;
      if (at === target) {
        raf = 0;
        target = null;
        return;
      }
      raf = requestAnimationFrame(frame);
    };
    const onWheel = (e: WheelEvent) => {
      const move = wheelStep(e, {
        scroll: strip.scrollLeft,
        max: strip.scrollWidth - strip.clientWidth,
        easing: target,
      });
      if (move.kind === "native") return;
      e.preventDefault();
      if (move.kind === "direct" || window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
        stop();
        strip.scrollLeft = move.to;
        return;
      }
      if (target == null) at = strip.scrollLeft;
      target = move.to;
      if (!raf) raf = requestAnimationFrame(frame);
    };

    strip.addEventListener("wheel", onWheel, { passive: false });
    return () => {
      strip.removeEventListener("wheel", onWheel);
      stop();
    };
  }, [stripRef]);
}
