// -- Component Imports --
import { ConfirmDialog } from "../common/ConfirmDialog/ConfirmDialog";

// -- i18n Imports --
import { useT } from "../../i18n";

/**
 * The confirm behind an album, single or bulk delete. With no playlist involved it is the plain prompt.
 * When albums sit in playlists it takes a title and says what happens to them: each entry turns into its
 * tracks, which stay in the playlist. `bulk` is the selection bar's delete, whose count and undo sentence
 * it keeps; `count` is the number picked, `inPlaylists` how many playlists hold the album (one delete) or
 * how many of the picked albums sit in playlists (bulk). Singles never hold entries, so they never pass a
 * playlist count.
 */
export function AlbumDeleteConfirm({
  open,
  single,
  bulk,
  count,
  inPlaylists,
  onConfirm,
  onClose,
}: {
  open: boolean;
  single: boolean;
  bulk: boolean;
  count: number;
  inPlaylists: number;
  onConfirm: () => void;
  onClose: () => void;
}) {
  const t = useT();
  const held = inPlaylists > 0;

  const title = !held
    ? undefined
    : bulk
      ? t((d) => d.albums.deleteSelectedTitle, { n: count })
      : t((d) => d.albums.deleteConfirm);

  const prompt = held
    ? bulk
      ? `${t((d) => d.albums.deleteSelectedInPlaylists, { n: inPlaylists })} ${t((d) => d.albums.undoCleared)}`
      : t((d) => d.albums.deleteInPlaylists, { n: inPlaylists })
    : single
      ? bulk
        ? t((d) => d.singles.removeSelectedConfirm, { n: count })
        : t((d) => d.singles.removeConfirm)
      : bulk
        ? t((d) => d.albums.deleteSelectedConfirm, { n: count })
        : t((d) => d.albums.deleteConfirm);

  return (
    <ConfirmDialog
      open={open}
      title={title}
      prompt={prompt}
      confirmLabel={single ? t((d) => d.singles.removeAction) : t((d) => d.albums.deleteAction)}
      cancelLabel={t((d) => d.common.cancel)}
      onConfirm={onConfirm}
      onClose={onClose}
      destructive
    />
  );
}
