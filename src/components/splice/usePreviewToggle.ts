// -- Framework Imports --
import { useCallback } from "react";

// -- State Imports --
import { usePlayerActions, usePlayerStatus } from "../../state/player/store";

// -- IPC Imports --
import { playerPreview } from "../../lib/ipc";

/**
 * The workbench preview toggle, shared by the mini-transport button and the Space shortcut so both do
 * the same thing. A sounding preview is the engine playing with no library track loaded; toggling stops
 * it, otherwise it auditions from the playhead to the end of the file.
 */
export function usePreviewToggle(
  path: string,
  playheadSecs: number,
  durationSecs: number,
): { sounding: boolean; toggle: () => void; stop: () => void } {
  const status = usePlayerStatus();
  const { stop } = usePlayerActions();
  const sounding = status.playing && status.track_id == null;

  const toggle = useCallback(() => {
    if (sounding) stop();
    else void playerPreview(path, playheadSecs, durationSecs).catch(() => {});
  }, [sounding, stop, path, playheadSecs, durationSecs]);

  const stopPreview = useCallback(() => {
    if (sounding) stop();
  }, [sounding, stop]);

  return { sounding, toggle, stop: stopPreview };
}
