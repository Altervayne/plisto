// -- Framework Imports --
import { useState } from "react";

// -- Component Imports --
import { QuietButton } from "../common/QuietButton";

// -- State Imports --
import { useDeleteAlbum } from "../../state/organize/store";

// -- i18n Imports --
import { useT } from "../../i18n";

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
  const t = useT();

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
        <QuietButton onClick={() => setConfirming(true)}>{t((d) => d.albums.delete)}</QuietButton>
      </div>
    );
  }

  return (
    <div className={styles.wrap}>
      <span className={styles.prompt}>{t((d) => d.albums.deleteConfirm)}</span>
      <QuietButton onClick={() => void onDelete()}>{t((d) => d.albums.deleteAction)}</QuietButton>
      <QuietButton onClick={() => setConfirming(false)}>{t((d) => d.common.cancel)}</QuietButton>
    </div>
  );
}
