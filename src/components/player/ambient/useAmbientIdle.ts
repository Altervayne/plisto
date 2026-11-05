// -- Framework Imports --
import { useCallback, useEffect, useRef, useState } from "react";

// -- Local Imports --
import { createIdleTimer, type IdleTimer } from "./idleTimer";

/** How long the stage sits still before its chrome fades. */
export const AMBIENT_IDLE_MS = 5000;

/**
 * Ambient mode's idle state: `faded` turns on after AMBIENT_IDLE_MS with no `wake`, and any wake brings
 * the chrome straight back. The caller wires pointer and key activity to `wake`.
 */
export function useAmbientIdle(): { faded: boolean; wake: () => void } {
  const [faded, setFaded] = useState(false);
  const timerRef = useRef<IdleTimer | null>(null);

  useEffect(() => {
    const timer = createIdleTimer(AMBIENT_IDLE_MS, setFaded);
    timerRef.current = timer;
    return () => {
      timer.dispose();
      timerRef.current = null;
    };
  }, []);

  const wake = useCallback(() => timerRef.current?.wake(), []);
  return { faded, wake };
}
