// -- Framework Imports --
import { useEffect, useRef } from "react";

// -- Hook Imports --
import { useMountTransition } from "../../hooks/useMountTransition";

// -- State Imports --
import { usePlayerError, useSetPlayerError } from "../../state/player/store";

// -- i18n Imports --
import { useT } from "../../i18n";

// -- Style Imports --
import styles from "./QueueToast.module.css";

/** How long the toast holds before it clears itself. */
const VISIBLE_MS = 4000;

/** The exit before it unmounts, matching --dur-fast on the exit keyframe. */
const EXIT_MS = 120;

/**
 * The "can't play this file" nudge: the same foot-of-the-window pill as the queue toast, on the same
 * material, so a playback failure reads as one quiet line rather than an alarm. It shows when the
 * player store holds an error - a file the OS delivered that could not be read, most often - then
 * clears the error back to null as it dismisses. Mount it once beside the queue toast. The message
 * survives the exit fade through a ref, so it stays put while the store empties.
 */
export function PlayerErrorToast() {
  const error = usePlayerError();
  const setError = useSetPlayerError();
  const t = useT();
  const toast = useMountTransition(error != null, EXIT_MS);

  // Clear the error as the visible window ends; the fade rides the flip to null.
  useEffect(() => {
    if (error == null) return;
    const timer = window.setTimeout(() => setError(null), VISIBLE_MS);
    return () => window.clearTimeout(timer);
  }, [error, setError]);

  const message = t((d) => d.player.cantPlayFile);
  const lastMessage = useRef(message);
  if (error != null) lastMessage.current = message;

  if (!toast.mounted) return null;

  return (
    <div className={styles.toast} data-state={toast.state} role="status" aria-live="polite">
      <span className={styles.text}>{lastMessage.current}</span>
    </div>
  );
}
