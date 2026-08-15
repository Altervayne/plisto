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

// -- Hook Imports --
import { useDrawerResize } from "../common/Resizer/useDrawerResize";

// -- State Imports --
import { useTrack } from "../../state/store";
import { usePlaylists, usePlaylistTracks } from "../../state/playlists/store";

// -- Type Imports --
import type { Crumb } from "../../state/files/folderTree";

// -- i18n Imports --
import { useT } from "../../i18n";

// -- Style Imports --
import styles from "./PlaylistView.module.css";

/**
 * A playlist opened like a folder: a breadcrumb back to the list, the editable header, and the ordered
 * slot list, with a resizable track peek on the right - mirroring the album full-pane view, but flat
 * and slot-keyed.
 *
 * The peek needs a real library `TrackRow` (its edit layer and raw fields), not the playlist slot, so it
 * resolves the open slot's `track_id` against the store. No `albumFallback`: a playlist is not an album
 * container, so album/artist/year fall back to raw, the Files behavior. `openSlotId` keys on the slot,
 * not the track, so a repeated track opens its own row; a sentinel keeps the hook order stable when
 * nothing is open.
 */
export function PlaylistView({
  playlistId,
  onBack,
}: {
  playlistId: number;
  onBack: () => void;
}) {
  const t = useT();
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
        <ScrollArea className={styles.main} contentClassName={styles.mainInner}>
          {playlist ? (
            <PlaylistHeader playlist={playlist} onDeleted={onBack} />
          ) : null}
          <div className={styles.tracks}>
            <PlaylistTrackList
              playlistId={playlistId}
              onOpenSlot={setOpenSlotId}
              openSlotId={openSlotId}
            />
          </div>
        </ScrollArea>

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
