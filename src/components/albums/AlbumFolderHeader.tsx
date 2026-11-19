// -- Component Imports --
import { EditableField } from "../common/EditableField/EditableField";
import { AlbumCoverField } from "./AlbumCoverField";
import { AlbumMetaFields } from "./AlbumMetaFields";
import { GoneDoorLine } from "../gone/GoneDoorLine";

// -- State Imports --
import { useCommitAlbumFields } from "../../state/organize/store";
import { useAlbumGoneCount } from "../../state/gone/goneIn";
import { useOpenGone } from "../../state/shell/store";

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
 * An album with gone members adds a line under the fields that opens the gone sheet on it.
 */
export function AlbumFolderHeader({ album }: { album: AlbumRow }) {
  const commit = useCommitAlbumFields();
  const openGone = useOpenGone();
  const gone = useAlbumGoneCount(album.id);
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
        <AlbumCoverField albumId={album.id} hasCover={album.cover_id != null} />
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
        {gone > 0 ? (
          <GoneDoorLine
            text={t((d) => d.gone.albumLine, { n: gone })}
            action={t((d) => d.gone.findThem)}
            onAction={() => openGone({ kind: "album", albumId: album.id })}
          />
        ) : null}
      </div>
    </header>
  );
}
