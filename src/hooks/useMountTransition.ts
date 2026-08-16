/*
 * Holds a conditionally rendered element on screen long enough to play an exit. React tears a node down
 * the instant its flag flips, so there is nothing left to animate out; this keeps it mounted through the
 * exit window and stamps a state the CSS keys its enter/exit keyframes off. One primitive covers the
 * modal, the popovers, and both selection bars.
 *
 * Reduced motion: the exit is a JS timer, the one thing the global reduced-motion rule in base.css cannot
 * reach - a keyframe collapsed to near-zero still leaves the node mounted for the full timeout. So the
 * hook reads prefers-reduced-motion itself and drops the delay to 0, unmounting on the next tick to match
 * the instant state change the CSS forces on everything else.
 */

// -- Framework Imports --
import { useEffect, useState } from "react";

/** Which phase the mounted element is in, stamped as a data-state attribute for the CSS to key off. */
export type MountState = "enter" | "exit";

/**
 * Gates rendering on `open` while deferring unmount by `exitMs`. `mounted` says whether to render at all;
 * `state` is "enter" while open and "exit" during the departure. Feed `exitMs` the same duration the exit
 * keyframe uses so the node leaves the tree exactly as its animation ends.
 */
export function useMountTransition(open: boolean, exitMs: number): { mounted: boolean; state: MountState } {
  const [mounted, setMounted] = useState(open);
  const [state, setState] = useState<MountState>(open ? "enter" : "exit");

  useEffect(() => {
    if (open) {
      setMounted(true);
      setState("enter");
      return;
    }
    if (!mounted) return;
    setState("exit");
    const reduced = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    const timer = window.setTimeout(() => setMounted(false), reduced ? 0 : exitMs);
    return () => window.clearTimeout(timer);
  }, [open, exitMs, mounted]);

  return { mounted, state };
}
