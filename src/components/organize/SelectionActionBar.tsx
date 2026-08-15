// -- Framework Imports --
import { useState } from "react";

// -- Component Imports --
import { PrimaryButton } from "../common/PrimaryButton";
import { QuietButton } from "../common/QuietButton";
import { AlbumPicker } from "./AlbumPicker";
import { PlaylistPicker } from "../playlists/PlaylistPicker";
import { ExtractPanel } from "../extract/ExtractPanel";

// -- State Imports --
import { useAppStore, useTracks } from "../../state/store";
import {
  useAlbums,
  useAssignTracks,
  useClearSelection,
  useCreateAlbum,
  useCreateSingle,
  useLoadOrganization,
  useResetHistory,
  useSelection,
} from "../../state/organize/store";
import {
  useAddTracksToPlaylist,
  useCreatePlaylist,
  usePlaylists,
} from "../../state/playlists/store";

// -- Type Imports --
import type { ExtractTrack } from "../extract/ExtractPanel";

// -- Utils Imports --
import { suggestAlbumFields } from "../../state/organize/suggestFields";

// -- i18n Imports --
import { useT } from "../../i18n";

// -- Style Imports --
import styles from "./SelectionActionBar.module.css";

/**
 * The floating action bar over a track selection. It shows only while tracks are selected: a quiet
 * count summary at the left, and at the right the one solid-accent Create album beside the quiet
 * Make-single, Add-to-album and Clear. Create seeds the album from the selection's shared raw tags,
 * then clears the selection and hands the new album id up so the shell can open it; on failure it keeps
 * the selection and says so. Make single fans the selection out one-to-one - N tracks become N standalone
 * singles - then hands the new ids up. Add-to-album opens a picker of existing albums. All three reach
 * the backend through the store, which the native side confirms - here the selection, the count, and the
 * suggested fields are what render.
 */
export function SelectionActionBar({
  onCreated,
  onMadeSingles,
}: {
  onCreated: (albumId: number) => void;
  onMadeSingles: (ids: number[]) => void;
}) {
  const selection = useSelection();
  const tracks = useTracks();
  const albums = useAlbums();
  const createAlbum = useCreateAlbum();
  const createSingle = useCreateSingle();
  const assignTracks = useAssignTracks();
  const clearSelection = useClearSelection();
  const loadOrganization = useLoadOrganization();
  const resetHistory = useResetHistory();
  const playlists = usePlaylists();
  const createPlaylist = useCreatePlaylist();
  const addTracksToPlaylist = useAddTracksToPlaylist();
  const t = useT();

  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [pickerOpen, setPickerOpen] = useState(false);
  const [playlistPickerOpen, setPlaylistPickerOpen] = useState(false);
  // The extractor opens over a snapshot of the selection, so it holds its result even after the apply
  // clears the selection out from under the bar.
  const [extractTracks, setExtractTracks] = useState<ExtractTrack[] | null>(null);

  // Stays mounted while the extractor is open, so the bar itself hides on a cleared selection but the
  // modal keeps its summary.
  if (selection.size === 0 && !extractTracks) return null;

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

  const onMakeSingles = async () => {
    setError(null);
    setBusy(true);
    try {
      // One-to-one fan-out: each selected track becomes its own standalone single, in selection order.
      const ids: number[] = [];
      for (const trackId of selectedIds) ids.push(await createSingle(trackId));
      clearSelection();
      onMadeSingles(ids);
    } catch {
      setError(t((d) => d.singles.makeError));
    } finally {
      setBusy(false);
    }
  };

  const onChoose = (albumId: number) => {
    assignTracks(albumId, selectedIds);
    clearSelection();
    setPickerOpen(false);
  };

  // Add the selection to an existing playlist, then clear it. The picker holds a snapshot of the ids, so
  // clearing after does not undo the add.
  const onChoosePlaylist = (playlistId: number) => {
    void addTracksToPlaylist(playlistId, selectedIds);
    clearSelection();
    setPlaylistPickerOpen(false);
  };

  // Create a playlist from the typed name, add the selection to it, then clear.
  const onCreatePlaylist = async (name: string) => {
    const playlistId = await createPlaylist(name);
    await addTracksToPlaylist(playlistId, selectedIds);
    clearSelection();
    setPlaylistPickerOpen(false);
  };

  // Snapshots the selection into the extractor: each track keyed by id, its display path preferred over
  // the source path for the hover.
  const openExtract = () => {
    setExtractTracks(
      tracks
        .filter((track) => selection.has(track.id))
        .map((track) => ({
          id: track.id,
          filename: track.filename,
          path: track.display_path ?? track.source_path,
        })),
    );
  };

  // After a bulk apply, pull the fresh tracks and membership so the new tags show, drop the undo stack
  // (the apply wrote outside the command engine, so a stale inverse must never replay), then clear.
  const onExtractApplied = () => {
    void useAppStore.getState().loadTracks();
    void loadOrganization();
    resetHistory();
    clearSelection();
  };

  return (
    <>
      {selection.size > 0 ? (
        <>
          {pickerOpen ? (
            <AlbumPicker albums={albums} onChoose={onChoose} onClose={() => setPickerOpen(false)} />
          ) : null}

          {playlistPickerOpen ? (
            <PlaylistPicker
              playlists={playlists}
              onChoose={onChoosePlaylist}
              onCreate={(name) => void onCreatePlaylist(name)}
              onClose={() => setPlaylistPickerOpen(false)}
            />
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
              <QuietButton onClick={() => void onMakeSingles()} disabled={busy}>
                {t((d) => d.singles.make, { n: selection.size })}
              </QuietButton>
              <QuietButton
                onClick={() => {
                  setPlaylistPickerOpen(false);
                  setPickerOpen((open) => !open);
                }}
              >
                {t((d) => d.selection.addToAlbum)}
              </QuietButton>
              <QuietButton
                onClick={() => {
                  setPickerOpen(false);
                  setPlaylistPickerOpen((open) => !open);
                }}
              >
                {t((d) => d.playlists.addTo)}
              </QuietButton>
              <QuietButton onClick={openExtract}>{t((d) => d.extract.action)}</QuietButton>
              <QuietButton onClick={() => clearSelection()}>{t((d) => d.common.clear)}</QuietButton>
            </div>
          </div>
        </>
      ) : null}

      {extractTracks ? (
        <ExtractPanel
          tracks={extractTracks}
          onClose={() => setExtractTracks(null)}
          onApplied={onExtractApplied}
        />
      ) : null}
    </>
  );
}
