// -- Framework Imports --
import { useState } from "react";

// -- Component Imports --
import { QuietButton } from "../common/QuietButton";

// -- State Imports --
import { useRemovePlaylist } from "../../state/playlists/store";

// -- i18n Imports --
import { useT } from "../../i18n";

// -- Style Imports --
import styles from "./PlaylistDeleteControl.module.css";

/**
 * A two-step delete on the surface: the first press arms a confirm, the second removes the playlist and
 * leaves the pane. No browser dialog - the confirm is quiet controls on the ground. The tracks stay;
 * only the playlist and its slots go.
 */
export function PlaylistDeleteControl({
  playlistId,
  onDeleted,
}: {
  playlistId: number;
  onDeleted: () => void;
}) {
  const remove = useRemovePlaylist();
  const [confirming, setConfirming] = useState(false);
  const t = useT();

  const onDelete = async () => {
    try {
      await remove(playlistId);
      onDeleted();
    } catch {
      setConfirming(false);
    }
  };

  if (!confirming) {
    return (
      <div className={styles.wrap}>
        <QuietButton onClick={() => setConfirming(true)}>
          {t((d) => d.playlists.delete)}
        </QuietButton>
      </div>
    );
  }

  return (
    <div className={styles.wrap}>
      <span className={styles.prompt}>{t((d) => d.playlists.deleteConfirm)}</span>
      <QuietButton onClick={() => void onDelete()}>
        {t((d) => d.playlists.deleteAction)}
      </QuietButton>
      <QuietButton onClick={() => setConfirming(false)}>{t((d) => d.common.cancel)}</QuietButton>
    </div>
  );
}
