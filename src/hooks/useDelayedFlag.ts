// -- Framework Imports --
import { useEffect, useState } from "react";

/**
 * Follows `on`, but turns true only once it has held for `delayMs`, so a state that flips on and off
 * quickly never shows. Turning off is immediate.
 */
export function useDelayedFlag(on: boolean, delayMs: number): boolean {
  const [held, setHeld] = useState(false);

  useEffect(() => {
    if (!on) {
      setHeld(false);
      return;
    }
    const timer = window.setTimeout(() => setHeld(true), delayMs);
    return () => window.clearTimeout(timer);
  }, [on, delayMs]);

  return on && held;
}
