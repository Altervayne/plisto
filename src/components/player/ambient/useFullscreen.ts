// -- Framework Imports --
import { useEffect } from "react";

// -- Utils Imports --
import { isWindowMaximized, setWindowFullscreen, toggleMaximizeWindow } from "../../../lib/appWindow";

// Window calls run one after another, so a quick enter and exit (or a dev double mount) can never land
// out of order and strand the window in the wrong state.
let queue: Promise<unknown> = Promise.resolve();
function serial<T>(op: () => Promise<T>): Promise<T> {
  const next = queue.then(op, op);
  queue = next.catch(() => {});
  return next;
}

/**
 * Holds the window in OS full-screen while mounted, then restores the state it had before: leaving
 * full-screen brings back the prior bounds, and a window that was maximized and came back restored is
 * maximized again.
 */
export function useFullscreen(): void {
  useEffect(() => {
    const entered = serial(async () => {
      const wasMaximized = await isWindowMaximized();
      await setWindowFullscreen(true);
      return wasMaximized;
    });
    return () => {
      void serial(async () => {
        const wasMaximized = await entered;
        await setWindowFullscreen(false);
        if (wasMaximized && !(await isWindowMaximized())) toggleMaximizeWindow();
      });
    };
  }, []);
}
