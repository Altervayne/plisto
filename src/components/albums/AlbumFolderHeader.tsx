// -- Component Imports --
import { EditableField } from "../common/EditableField/EditableField";
import { AlbumCoverField } from "./AlbumCoverField";
import { AlbumMetaFields } from "./AlbumMetaFields";

// -- State Imports --
import { useCommitAlbumFields } from "../../state/organize/store";

// -- Type Imports --
import type { AlbumRow } from "../../types";

// -- i18n Imports --
import { useT } from "../../i18n";

// -- Style Imports --
import styles from "./AlbumFolderHeader.module.css";

/**
 * The album header for the full-pane view: the cover on the left, the editable title over its metadata
 * on the right. Reuses the drawer's cover and meta fields, laid out wide instead of stacked. The title
 * commits the full album field set with its one column replaced, the same path the drawer's title takes.
 */
export function AlbumFolderHeader({ album }: { album: AlbumRow }) {
  const commit = useCommitAlbumFields();
  const t = useT();
  const fields = {
    title: album.title,
    album_artist: album.album_artist,
    year: album.year,
    genre: album.genre,
  };

  return (
    <header className={styles.header}>
      <div className={styles.cover}>
        <AlbumCoverField albumId={album.id} />
      </div>
      <div className={styles.meta}>
        <EditableField
          value={album.title ?? ""}
          ariaLabel={t((d) => d.albums.albumTitle)}
          placeholder={t((d) => d.albums.untitled)}
          big
          onCommit={(next) => commit(album.id, { ...fields, title: next === "" ? null : next })}
        />
        <AlbumMetaFields album={album} />
      </div>
    </header>
  );
}
