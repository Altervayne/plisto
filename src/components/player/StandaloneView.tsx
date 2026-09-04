// -- Framework Imports --
import { useEffect, useState } from "react";

// -- Component Imports --
import { StandaloneCard, StandaloneErrorCard } from "./StandaloneCard";
import { PlayerErrorToast } from "./PlayerErrorToast";

// -- State Imports --
import { useCurrentTrackId, usePlayerError, usePlayerSync } from "../../state/player/store";
import { useSpectrumSync } from "../../state/player/spectrum";

// -- IPC Imports --
import { playerPlayFiles } from "../../lib/ipc";

/** The trailing name of a path with its extension dropped, so a failed file reads by its own name. */
function fileStem(path: string): string {
  const leaf = path.split(/[\\/]/).filter(Boolean).pop() ?? path;
  const dot = leaf.lastIndexOf(".");
  return dot > 0 ? leaf.slice(0, dot) : leaf;
}

/**
 * The compact standalone player mounted when Plisto is cold-launched by opening a file. It self-wires the
 * player and spectrum syncs the full app's shell normally owns (that shell never mounts here), plays the
 * handed files once, and renders the card. When every file is unreadable - the play rejected, or nothing
 * ever holds and the engine's file notice fired - it shows the honest error body instead of the playing
 * card, with the same "Open library" escape the title bar carries.
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

  // Play the handed files once. A rejection means every file was unreadable; the card falls to its error
  // body. A partial failure resolves - the readable files play - so it never trips this.
  useEffect(() => {
    setFailed(false);
    void playerPlayFiles(files).catch(() => setFailed(true));
  }, [files]);

  // Errored only when nothing plays: the play rejected, or the engine reported a file notice and still
  // holds no track. A survivor playing (a non-null track id) is never an error, even beside a notice from
  // one file that dropped out.
  const errored = failed || (trackId == null && error === "file");

  if (errored) {
    return <StandaloneErrorCard stem={fileStem(files[0])} onOpenLibrary={onOpenLibrary} />;
  }
  return (
    <>
      <StandaloneCard trackId={trackId} total={files.length} />
      {/* The full app mounts the notice toast in its shell, which never mounts here. Without it, a
          partial failure - one of several files fails while the rest play - and any output/device
          notice would go unheard in compact. The all-fail case renders the error body above instead,
          so the toast never doubles that message. */}
      <PlayerErrorToast />
    </>
  );
}
