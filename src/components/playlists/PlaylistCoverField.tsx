// -- Framework Imports --
import { useState } from "react";

// -- Component Imports --
import { Cover } from "../common/Cover/Cover";
import { CoverActions } from "../common/CoverActions/CoverActions";

// -- Hook Imports --
import { usePlaylistCover } from "./usePlaylistCover";

// -- State Imports --
import { useRemovePlaylistCover, useSetPlaylistCover } from "../../state/playlists/store";

// -- Utils Imports --
import { pickImageFile } from "../../lib/dialog";

// -- i18n Imports --
import { useT } from "../../i18n";

// -- Style Imports --
import styles from "./PlaylistCoverField.module.css";

/**
 * The playlist cover slot in the header: the bound art with a glass Replace/Remove on hover, or a sunken
 * Add-cover recess when the playlist has none. Picking an image binds it through the store and reloads the
 * tile; Remove drops it back to the recess. A playlist cover is only ever the imported one - no candidate
 * art, no member-track fallback, so this trims the album field's provenance line and fallback handling.
 */
export function PlaylistCoverField({ playlistId }: { playlistId: number }) {
  const { src, reload } = usePlaylistCover(playlistId, "detail");
  const setCover = useSetPlaylistCover();
  const removeCover = useRemovePlaylistCover();
  const [error, setError] = useState<string | null>(null);
  const t = useT();

  const replace = async () => {
    const path = await pickImageFile();
    if (!path) return;
    try {
      await setCover(playlistId, path);
      reload();
    } catch {
      setError(t((d) => d.cover.setError));
    }
  };

  const remove = async () => {
    try {
      await removeCover(playlistId);
      reload();
    } catch {
      setError(t((d) => d.cover.setError));
    }
  };

  return (
    <section className={styles.section} aria-label={t((d) => d.cover.playlistLabel)}>
      {src ? (
        <div className={styles.slot}>
          <Cover src={src} alt="" />
          <CoverActions
            actions={[
              { label: t((d) => d.cover.replace), onClick: () => void replace() },
              { label: t((d) => d.cover.remove), onClick: () => void remove() },
            ]}
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
    </section>
  );
}
