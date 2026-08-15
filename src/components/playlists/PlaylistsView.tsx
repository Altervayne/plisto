// -- Component Imports --
import { ScrollArea } from "../common/ScrollArea/ScrollArea";
import { PrimaryButton } from "../common/PrimaryButton";
import { EmptyState } from "../common/EmptyState";
import { PlaylistRow } from "./PlaylistRow";

// -- State Imports --
import { useCreatePlaylist, usePlaylists } from "../../state/playlists/store";

// -- i18n Imports --
import { useT } from "../../i18n";

// -- Style Imports --
import styles from "./PlaylistsView.module.css";

/**
 * The playlists list: a calm stack of rows on the continuous surface, no cover-art grid - a playlist
 * holds only an ordered set of tracks. Each row renames in place, shows its count, and opens on click.
 * New playlist creates an empty one and opens it straight away, so the first act is filling it. With
 * none yet it stands as an idle empty state carrying the same create action.
 */
export function PlaylistsView({ onOpen }: { onOpen: (id: number) => void }) {
  const playlists = usePlaylists();
  const create = useCreatePlaylist();
  const t = useT();

  const onNew = async () => {
    const id = await create(null);
    onOpen(id);
  };

  if (playlists.length === 0) {
    return (
      <EmptyState
        tone="idle"
        title={t((d) => d.playlists.emptyTitle)}
        line={t((d) => d.playlists.emptyLine)}
        action={
          <PrimaryButton onClick={() => void onNew()}>
            {t((d) => d.playlists.newPlaylist)}
          </PrimaryButton>
        }
      />
    );
  }

  return (
    <div className={styles.view}>
      <div className={styles.head}>
        <h1 className={styles.title}>{t((d) => d.playlists.nav)}</h1>
        <PrimaryButton onClick={() => void onNew()}>
          {t((d) => d.playlists.newPlaylist)}
        </PrimaryButton>
      </div>

      <ScrollArea className={styles.scroll} contentClassName={styles.list}>
        {playlists.map((playlist) => (
          <PlaylistRow key={playlist.id} playlist={playlist} onOpen={() => onOpen(playlist.id)} />
        ))}
      </ScrollArea>
    </div>
  );
}
