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

// -- i18n Imports --
import { useT } from "../../i18n";

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
  const t = useT();

  const replace = async () => {
    const path = await pickImageFile();
    if (!path) return;
    try {
      await setAlbumCover(albumId, path);
      reload();
    } catch {
      setError(t((d) => d.cover.setError));
    }
  };

  return (
    <section className={styles.section} aria-label={t((d) => d.cover.albumLabel)}>
      {src ? (
        <div className={styles.slot}>
          <Cover src={src} alt="" />
          <CoverActions
            actions={[{ label: t((d) => d.cover.replace), onClick: () => void replace() }]}
          />
        </div>
      ) : (
        <button
          type="button"
          className={styles.addSlot}
          onClick={() => void replace()}
          aria-label={t((d) => d.cover.add)}
        >
          <Cover src={null} />
          <span className={styles.addHint}>{t((d) => d.cover.add)}</span>
        </button>
      )}

      {error ? <p className={styles.error}>{error}</p> : null}

      <p className={styles.safety}>{t((d) => d.cover.embedNote)}</p>
    </section>
  );
}
