// -- Framework Imports --
import { useState } from "react";

// -- Component Imports --
import { Cover } from "../common/Cover/Cover";
import { CoverActions } from "../common/CoverActions/CoverActions";

// -- Hook Imports --
import { useAlbumCover } from "./useAlbumCover";

// -- State Imports --
import { useSetAlbumCover } from "../../state/organize/store";

// -- Utils Imports --
import { pickImageFile } from "../../lib/dialog";

// -- Style Imports --
import styles from "./AlbumCoverField.module.css";

/**
 * The album cover slot at the top of the drawer: the resolved art with a glass Replace on hover, or a
 * sunken Add-cover recess when the album has none. Picking an image binds it through the store and
 * reloads the tile. The resolved cover is the bound one, else a member track's art - the backend
 * decides; this only renders and wires Replace.
 */
export function AlbumCoverField({ albumId }: { albumId: number }) {
  const { src, reload } = useAlbumCover(albumId, "detail");
  const setAlbumCover = useSetAlbumCover();
  const [error, setError] = useState<string | null>(null);

  const replace = async () => {
    const path = await pickImageFile();
    if (!path) return;
    try {
      await setAlbumCover(albumId, path);
      reload();
    } catch {
      setError("Could not set the cover.");
    }
  };

  return (
    <section className={styles.section} aria-label="Album cover">
      {src ? (
        <div className={styles.slot}>
          <Cover src={src} alt="" />
          <CoverActions actions={[{ label: "Replace cover", onClick: () => void replace() }]} />
        </div>
      ) : (
        <button
          type="button"
          className={styles.addSlot}
          onClick={() => void replace()}
          aria-label="Add cover"
        >
          <Cover src={null} />
          <span className={styles.addHint}>Add cover</span>
        </button>
      )}

      {error ? <p className={styles.error}>{error}</p> : null}

      <p className={styles.safety}>covers embed into the exported copy, never your originals</p>
    </section>
  );
}
