/*
 * Standalone's play-once tracking. `failed` latches when the launch refused every handed file;
 * `started` latches the first track that ever held, so a genuine end-of-queue defers to PlayerView's
 * empty state rather than looping back to the pre-first-track load.
 */

// -- Framework Imports --
import { useEffect, useState } from "react";

// -- State Imports --
import { useCurrentTrackId, usePlayerError } from "../../state/player/store";

// -- IPC Imports --
import { getStartupError } from "../../lib/ipc";

export function useStandalonePlayback(standalone: boolean): {
  playbackErrored: boolean;
  started: boolean;
} {
  const trackId = useCurrentTrackId();
  const playerNotice = usePlayerError();
  const [failed, setFailed] = useState(false);
  const [started, setStarted] = useState(false);
  // Errored only when nothing plays: the play rejected, or the engine reported a file notice and still
  // holds no track. A survivor playing is never an error, even beside a notice from one file that dropped.
  const playbackErrored =
    standalone && (failed || (trackId == null && playerNotice === "file"));

  // Pull only the take-once launch error: an all-unreadable batch latches it, so the refusal body shows
  // even when the batch's file notice fired before this shell subscribed. The files themselves play from
  // the backend intake buffer, not here. A batch that plays clears the region to the player.
  useEffect(() => {
    if (!standalone) return;
    void getStartupError()
      .then((notice) => {
        if (notice) setFailed(true);
      })
      .catch(() => {});
  }, [standalone]);

  // Latch the first track that ever holds; after it, PlayerView owns the empty state.
  useEffect(() => {
    if (trackId != null) setStarted(true);
  }, [trackId]);

  return { playbackErrored, started };
}
