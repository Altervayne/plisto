// -- State Imports --
import { usePlayerStore } from "../../state/player/store";

// -- Format Imports --
import { formatDuration } from "../../lib/format";

/**
 * The elapsed time of a stream item with a known length, as its own subscriber so the surface around it
 * never re-renders on a tick. The selector returns a whole second, or -1 with no known length, which
 * renders nothing.
 */
export function StreamElapsed({ className }: { className?: string }) {
  const secs = usePlayerStore((s) =>
    s.status.duration_secs > 0 ? Math.floor(s.status.position_secs) : -1,
  );
  if (secs < 0) return null;
  return <span className={`${className ?? ""} tabular`.trim()}>{formatDuration(secs)}</span>;
}
