// -- Framework Imports --
import { useState } from "react";

// -- Component Imports --
import { PrimaryButton } from "../common/PrimaryButton";
import { QuietButton } from "../common/QuietButton";
import { AlbumPicker } from "./AlbumPicker";

// -- State Imports --
import { useTracks } from "../../state/store";
import {
  useAlbums,
  useAssignTracks,
  useClearSelection,
  useCreateAlbum,
  useSelection,
} from "../../state/organize/store";

// -- Utils Imports --
import { suggestAlbumFields } from "../../state/organize/suggestFields";

// -- i18n Imports --
import { useT } from "../../i18n";

// -- Style Imports --
import styles from "./SelectionActionBar.module.css";

/**
 * The floating action bar over a track selection. It shows only while tracks are selected: a quiet
 * count summary at the left, and at the right the one solid-accent Create album beside the quiet
 * Add-to-album and Clear. Create seeds the album from the selection's shared raw tags, then clears the
 * selection and hands the new album id up so the shell can open it; on failure it keeps the selection
 * and says so. Add-to-album opens a picker of existing albums. Both reach the backend through the
 * store, which the native side confirms - here the selection, the count, and the suggested fields are
 * what render.
 */
export function SelectionActionBar({
  onCreated,
}: {
  onCreated: (albumId: number) => void;
}) {
  const selection = useSelection();
  const tracks = useTracks();
  const albums = useAlbums();
  const createAlbum = useCreateAlbum();
  const assignTracks = useAssignTracks();
  const clearSelection = useClearSelection();
  const t = useT();

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);

  if (selection.size === 0) return null;

  const selectedIds = [...selection];

  const onCreate = async () => {
    setError(null);
    setBusy(true);
    try {
      const rows = tracks.filter((t) => selection.has(t.id));
      const albumId = await createAlbum(suggestAlbumFields(rows), selectedIds);
      clearSelection();
      onCreated(albumId);
    } catch {
      setError(t((d) => d.selection.createError));
    } finally {
      setBusy(false);
    }
  };

  const onChoose = (albumId: number) => {
    assignTracks(albumId, selectedIds);
    clearSelection();
    setPickerOpen(false);
  };

  return (
    <>
      {pickerOpen ? (
        <AlbumPicker albums={albums} onChoose={onChoose} onClose={() => setPickerOpen(false)} />
      ) : null}

      <div className={styles.bar} role="toolbar" aria-label={t((d) => d.selection.actions)}>
        <div className={styles.summary}>
          <span className={styles.count}>{selection.size}</span>
          <span className={styles.label}>{t((d) => d.selection.selected)}</span>
        </div>

        {error ? <span className={styles.error}>{error}</span> : null}

        <div className={styles.actions}>
          <PrimaryButton onClick={() => void onCreate()} disabled={busy}>
            {t((d) => d.selection.createAlbum)}
          </PrimaryButton>
          <QuietButton onClick={() => setPickerOpen((open) => !open)}>
            {t((d) => d.selection.addToAlbum)}
          </QuietButton>
          <QuietButton onClick={() => clearSelection()}>{t((d) => d.common.clear)}</QuietButton>
        </div>
      </div>
    </>
  );
}
