// -- Framework Imports --
import { useEffect, useState } from "react";
import type { CSSProperties } from "react";

// -- Component Imports --
import { Breadcrumb } from "../files/Breadcrumb";
import { ScrollArea } from "../common/ScrollArea/ScrollArea";
import { Resizer } from "../common/Resizer/Resizer";
import { PlaylistHeader } from "./PlaylistHeader";
import { PlaylistTrackList } from "./PlaylistTrackList";
import { TrackDetail } from "../tracks/TrackDetail";
import { ProjectionPending } from "../organize/ProjectionPending";

// -- Hook Imports --
import { useDrawerResize } from "../common/Resizer/useDrawerResize";

// -- State Imports --
import { useTrack } from "../../state/store";
import { usePlaylists, usePlaylistTracks } from "../../state/playlists/store";
import { usePlaylistsStatus } from "../../state/projectionStatus";

// -- Type Imports --
import type { Crumb } from "../../state/files/folderTree";

// -- i18n Imports --
import { useT } from "../../i18n";

// -- Style Imports --
import styles from "./PlaylistView.module.css";

/**
 * A playlist opened like a folder: a breadcrumb back to the list, the editable header, and the ordered
 * row list, with a resizable track peek on the right - mirroring the album full-pane view, but flat
 * and slot-keyed.
 *
 * The peek needs a real library `TrackRow`, not the playlist slot, so it resolves the open slot's
 * `track_id` against the store; an album entry has no peek, it unfolds in the list. No `albumFallback`: a
 * playlist is not an album container. `openSlotId` keys on the slot, not the track, so a repeated track
 * opens its own row; a sentinel keeps the hook order stable when nothing is open. `onOpenAlbum` routes an
 * entry's Open album to the Collection.
 */
export function PlaylistView({
  playlistId,
  onBack,
  onOpenAlbum,
}: {
  playlistId: number;
  onBack: () => void;
  onOpenAlbum: (albumId: number) => void;
}) {
  const t = useT();
  const status = usePlaylistsStatus();
  const { width, containerRef, resizer } = useDrawerResize();
  const playlists = usePlaylists();
  const tracks = usePlaylistTracks(playlistId);
  const [openSlotId, setOpenSlotId] = useState<number | null>(null);

  // Moving to another playlist drops any open peek: the slot need not exist in the new one.
  useEffect(() => {
    setOpenSlotId(null);
  }, [playlistId]);

  const openSlot = tracks.find((slot) => slot.id === openSlotId) ?? null;
  const trackRow = useTrack(openSlot?.track_id ?? -1);

  const playlist = playlists.find((p) => p.id === playlistId) ?? null;
  const name = playlist?.name ?? t((d) => d.playlists.untitled);
  const crumbs: Crumb[] = [
    { id: "playlists", name: t((d) => d.playlists.nav) },
    { id: String(playlistId), name },
  ];

  return (
    <div className={styles.view}>
      <div className={styles.header}>
        <Breadcrumb
          crumbs={crumbs}
          atRoot={false}
          onNavigate={(id) => {
            if (id === "playlists") onBack();
          }}
          onUp={onBack}
        />
      </div>

      <div
        className={styles.body}
        ref={containerRef}
        style={{ "--drawer-width": `${width}px` } as CSSProperties}
      >
        {status !== "ready" ? (
          <ProjectionPending state={status} />
        ) : (
          <ScrollArea className={styles.main} contentClassName={styles.mainInner}>
            {playlist ? (
              <PlaylistHeader playlist={playlist} onDeleted={onBack} />
            ) : null}
            <div className={styles.tracks}>
              <PlaylistTrackList
                playlistId={playlistId}
                onOpenSlot={setOpenSlotId}
                openSlotId={openSlotId}
                onOpenAlbum={onOpenAlbum}
              />
            </div>
          </ScrollArea>
        )}

        {trackRow ? (
          <div className={styles.panel}>
            <Resizer resizer={resizer} />
            <TrackDetail track={trackRow} onClose={() => setOpenSlotId(null)} />
          </div>
        ) : null}
      </div>
    </div>
  );
}
