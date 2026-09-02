// -- Framework Imports --
import { useCallback, useRef, useState } from "react";

// -- State Imports --
import { usePlayerStore } from "../../state/player/store";

// -- IPC Imports --
import { playerPreview } from "../../lib/ipc";

/** Clamps seconds into the file's playable range. */
function clampSecs(secs: number, durationSecs: number): number {
  return Math.min(durationSecs, Math.max(0, secs));
}

/**
 * The scrub-while-playing bridge. While a lane scrub is in progress `isScrubbing` gates the transport's
 * playhead sync off, so the engine's position ticks never fight the dragged cursor. On release, if a
 * preview is still sounding, playback re-issues from where the cursor landed - a restart bound strictly
 * to the release, never fired per pointer move. The latest playhead rides a ref, fed through
 * `notePlayhead`, so the release reads the dropped position without a stale closure.
 */
export function usePreviewScrub(
  path: string,
  durationSecs: number,
): {
  isScrubbing: boolean;
  notePlayhead: (secs: number) => void;
  onScrubStart: () => void;
  onScrubEnd: () => void;
} {
  const [isScrubbing, setIsScrubbing] = useState(false);
  const playheadRef = useRef(0);

  const notePlayhead = useCallback((secs: number) => {
    playheadRef.current = secs;
  }, []);

  const onScrubStart = useCallback(() => setIsScrubbing(true), []);

  const onScrubEnd = useCallback(() => {
    setIsScrubbing(false);
    const status = usePlayerStore.getState().status;
    // A live preview (the engine playing with no library track) resumes from the dropped playhead.
    if (status.playing && status.track_id == null) {
      void playerPreview(path, clampSecs(playheadRef.current, durationSecs), durationSecs).catch(
        () => {},
      );
    }
  }, [path, durationSecs]);

  return { isScrubbing, notePlayhead, onScrubStart, onScrubEnd };
}
