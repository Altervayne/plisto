// -- Framework Imports --
import { useState } from "react";

// -- Component Imports --
import { QuietButton } from "../common/QuietButton";

// -- State Imports --
import { useDeleteAlbum } from "../../state/organize/store";

// -- Style Imports --
import styles from "./AlbumDeleteControl.module.css";

/**
 * A two-step delete on the surface: the first press arms a confirm, the second removes the album and
 * closes the drawer. No browser dialog - the confirm is quiet controls on the ground. The tracks stay;
 * only the album and its membership go, so the members fall back to loose.
 */
export function AlbumDeleteControl({
  albumId,
  onDeleted,
}: {
  albumId: number;
  onDeleted: () => void;
}) {
  const deleteAlbum = useDeleteAlbum();
  const [confirming, setConfirming] = useState(false);

  const onDelete = async () => {
    try {
      await deleteAlbum(albumId);
      onDeleted();
    } catch {
      setConfirming(false);
    }
  };

  if (!confirming) {
    return (
      <div className={styles.wrap}>
        <QuietButton onClick={() => setConfirming(true)}>Delete album</QuietButton>
      </div>
    );
  }

  return (
    <div className={styles.wrap}>
      <span className={styles.prompt}>Delete this album?</span>
      <QuietButton onClick={() => void onDelete()}>Delete</QuietButton>
      <QuietButton onClick={() => setConfirming(false)}>Cancel</QuietButton>
    </div>
  );
}
