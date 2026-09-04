// -- Framework Imports --
import { useEffect, useState } from "react";

// -- Component Imports --
import { PlayerView } from "./PlayerView";
import { StandaloneErrorCard } from "./StandaloneErrorCard";
import { PlayerErrorToast } from "./PlayerErrorToast";
import { StaffSpinner } from "../scan/StaffSpinner";

// -- State Imports --
import { useCurrentTrackId, usePlayerError, usePlayerSync } from "../../state/player/store";
import { useSpectrumSync } from "../../state/player/spectrum";

// -- IPC Imports --
import { playerPlayFiles } from "../../lib/ipc";

// -- Style Imports --
import styles from "./StandaloneView.module.css";

/** The source line stays hidden anyway, so a direct file play never routes anywhere; the no-op satisfies
 * PlayerView's onNavigate without a library to route to. */
const noNavigate = () => {};

/** The trailing name of a path with its extension dropped, so a failed file reads by its own name. */
function fileStem(path: string): string {
  const leaf = path.split(/[\\/]/).filter(Boolean).pop() ?? path;
  const dot = leaf.lastIndexOf(".");
  return dot > 0 ? leaf.slice(0, dot) : leaf;
}

/**
 * The standalone player mounted when Plisto is cold-launched by opening a file: the full Player view with
 * no sidebar, at the normal window size. It self-wires the player and spectrum syncs the full app's shell
 * normally owns (that shell never mounts here), plays the handed files once, and reuses PlayerView - hero
 * plus up-next, which carries several opened files through its own queue. When every file is unreadable -
 * the play rejected, or nothing ever holds and the engine's file notice fired - it shows the honest error
 * body instead of the view, with the same "Open library" escape the title bar carries.
 */
export function StandaloneView({
  files,
  onOpenLibrary,
}: {
  files: string[];
  onOpenLibrary: () => void;
}) {
  usePlayerSync();
  useSpectrumSync();

  const trackId = useCurrentTrackId();
  const error = usePlayerError();
  const [failed, setFailed] = useState(false);
  const [started, setStarted] = useState(false);

  // Play the handed files once. A rejection means every file was unreadable; the view falls to its error
  // body. A partial failure resolves - the readable files play - so it never trips this.
  useEffect(() => {
    setFailed(false);
    void playerPlayFiles(files).catch(() => setFailed(true));
  }, [files]);

  // Latch the first track. Before it, the view shows the loading motion, not PlayerView's empty state;
  // after a track has ever held, defer to PlayerView so a genuine end-of-queue reads as "nothing playing"
  // rather than looping back to a spinner.
  useEffect(() => {
    if (trackId != null) setStarted(true);
  }, [trackId]);

  // Errored only when nothing plays: the play rejected, or the engine reported a file notice and still
  // holds no track. A survivor playing (a non-null track id) is never an error, even beside a notice from
  // one file that dropped out.
  const errored = failed || (trackId == null && error === "file");

  if (errored) {
    return <StandaloneErrorCard stem={fileStem(files[0])} onOpenLibrary={onOpenLibrary} />;
  }
  if (!started) {
    // Before the engine holds the first track, the app's loading motion - not PlayerView's "nothing
    // playing", which would misread the brief load as an idle player with the file already handed over.
    return (
      <div className={styles.stage}>
        <div className={styles.loading}>
          <StaffSpinner />
        </div>
      </div>
    );
  }
  return (
    <div className={styles.stage}>
      {/* onNavigate is a no-op: there is no library to route a source link to, and the source line stays
          hidden anyway since a direct file play carries no "playing from". */}
      <PlayerView onNavigate={noNavigate} />
      {/* The full app mounts the notice toast in its shell, which never mounts here. Without it, a partial
          failure - one of several files fails while the rest play - and any output/device notice would go
          unheard. The all-fail case renders the error body above instead, so the toast never doubles it. */}
      <PlayerErrorToast />
    </div>
  );
}
