// -- Framework Imports --
import { useEffect, useState } from "react";

// -- Hook Imports --
import { useMountTransition } from "../../hooks/useMountTransition";
import type { MountState } from "../../hooks/useMountTransition";

// How long the caption holds before it fades out.
const HOLD_MS = 4000;
// The caption's exit before it unmounts, matching --dur-soft on the exit keyframe.
const EXIT_MS = 200;

/**
 * The "{n} added" caption after a quiet scan: shown from the add's own stamp for a fixed hold, then
 * faded out. Timed from the stamp rather than from mount, so a remount never replays an old add. The
 * count outlives the hold so the caption keeps its text through the fade.
 */
export function useAddedCaption(
  added: { n: number; at: number } | null,
): { n: number; mounted: boolean; state: MountState } {
  const [showing, setShowing] = useState(false);
  const [n, setN] = useState(0);

  useEffect(() => {
    const left = added ? HOLD_MS - (Date.now() - added.at) : 0;
    if (!added || left <= 0) {
      setShowing(false);
      return;
    }
    setN(added.n);
    setShowing(true);
    const timer = window.setTimeout(() => setShowing(false), left);
    return () => window.clearTimeout(timer);
  }, [added]);

  return { n, ...useMountTransition(showing, EXIT_MS) };
}
