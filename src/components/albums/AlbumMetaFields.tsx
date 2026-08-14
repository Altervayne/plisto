// -- Component Imports --
import { EditableField } from "../common/EditableField/EditableField";
import { GenreChip } from "./GenreChip";

// -- State Imports --
import { useCommitAlbumFields } from "../../state/organize/store";

// -- Utils Imports --
import { formatYear, parseYear } from "./yearField";

// -- Type Imports --
import type { AlbumRow } from "../../types";

// -- i18n Imports --
import { useT } from "../../i18n";

// -- Style Imports --
import styles from "./AlbumMetaFields.module.css";

/**
 * The album's editable metadata under the cover: artist, year, and the genre chip. Each field commits
 * the full field set with its one column replaced, so a null clears a column and the DB never stores an
 * empty string. Year maps between its numeric column and the text field.
 */
export function AlbumMetaFields({ album }: { album: AlbumRow }) {
  const commit = useCommitAlbumFields();
  const t = useT();
  const fields = {
    title: album.title,
    album_artist: album.album_artist,
    year: album.year,
    genre: album.genre,
  };

  return (
    <dl className={styles.fields}>
      <div className={styles.field}>
        <dt className={styles.label}>{t((d) => d.albums.albumArtist)}</dt>
        <dd className={styles.value}>
          <EditableField
            value={album.album_artist ?? ""}
            ariaLabel={t((d) => d.albums.albumArtist)}
            placeholder={t((d) => d.albums.unknownArtist)}
            onCommit={(next) =>
              commit(album.id, { ...fields, album_artist: next === "" ? null : next })
            }
          />
        </dd>
      </div>

      <div className={`${styles.field} ${styles.year}`}>
        <dt className={styles.label}>{t((d) => d.albums.year)}</dt>
        <dd className={styles.value}>
          <EditableField
            value={formatYear(album.year)}
            ariaLabel={t((d) => d.albums.year)}
            placeholder={t((d) => d.albums.year)}
            onCommit={(next) => commit(album.id, { ...fields, year: parseYear(next) })}
          />
        </dd>
      </div>

      <div className={styles.field}>
        <dt className={styles.label}>{t((d) => d.albums.genre)}</dt>
        <dd className={styles.value}>
          <GenreChip
            value={album.genre}
            onCommit={(next) => commit(album.id, { ...fields, genre: next })}
          />
        </dd>
      </div>
    </dl>
  );
}
