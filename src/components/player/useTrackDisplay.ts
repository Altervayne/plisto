// -- Framework Imports --
import { useEffect, useRef, useState } from "react";

// -- IPC Imports --
import { getTrackDisplay } from "../../lib/ipc";

/**
 * A track's resolved title and artist by id, read straight over IPC so a satellite webview with no
 * library store can name the current track. Fetches on trackId change and holds the result; a null
 * id yields nulls with no call. The alive ref drops a late resolve after unmount, since the tray
 * webview can swap the shown track right before one lands.
 */
export function useTrackDisplay(trackId: number | null): {
  title: string | null;
  artist: string | null;
} {
  const [display, setDisplay] = useState<{ title: string | null; artist: string | null }>({
    title: null,
    artist: null,
  });
  const alive = useRef(true);

  useEffect(() => {
    alive.current = true;
    if (trackId == null) {
      setDisplay({ title: null, artist: null });
      return () => {
        alive.current = false;
      };
    }
    void getTrackDisplay(trackId)
      .then((d) => {
        if (alive.current) setDisplay(d);
      })
      .catch(() => {});
    return () => {
      alive.current = false;
    };
  }, [trackId]);

  return display;
}
