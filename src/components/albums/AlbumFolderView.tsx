// -- Framework Imports --
import { useEffect, useState } from "react";
import type { CSSProperties } from "react";

// -- Component Imports --
import { Breadcrumb } from "../files/Breadcrumb";
import { ScrollArea } from "../common/ScrollArea/ScrollArea";
import { Resizer } from "../common/Resizer/Resizer";
import { AlbumFolderHeader } from "./AlbumFolderHeader";
import { AlbumTrackList } from "./AlbumTrackList";
import { TrackDetail } from "../tracks/TrackDetail";

// -- Hook Imports --
import { useDrawerResize } from "../common/Resizer/useDrawerResize";

// -- State Imports --
import { useTrack } from "../../state/store";
import { useAlbumTracks, useSetTrackKeepOwnCover } from "../../state/organize/store";

// -- Type Imports --
import type { AlbumRow } from "../../types";
import type { Crumb } from "../../state/files/folderTree";

// -- i18n Imports --
import { useT } from "../../i18n";

// -- Style Imports --
import styles from "./AlbumFolderView.module.css";

/**
 * An album opened like a folder: a breadcrumb back to the grid, the editable album header, and the
 * album's track list, with a resizable track peek on the right. Mirrors the Files browser's header-over-
 * body split so the two library surfaces read alike. The track list runs in browse mode, so a row click
 * opens the peek rather than an inline edit.
 *
 * The peek needs a real library `TrackRow` (its disc edit, raw fields, and edit layer), not the album
 * membership row, so it resolves the open id against the store. A sentinel id keeps the hook order
 * stable when nothing is open. The peek reads the album's container album/album_artist/year through
 * `albumFallback`, so its preview of those fields matches what an export writes.
 */
export function AlbumFolderView({ album, onBack }: { album: AlbumRow; onBack: () => void }) {
  const t = useT();
  const { width, containerRef, resizer } = useDrawerResize();
  const [openTrackId, setOpenTrackId] = useState<number | null>(null);

  // Moving to another album drops any open peek: the track need not belong to the new one.
  useEffect(() => {
    setOpenTrackId(null);
  }, [album.id]);

  const trackRow = useTrack(openTrackId ?? -1);

  // The peek's keep-own-cover toggle reads the membership's flag, not the library track: the flag is
  // album-scoped. The open track's membership carries it; a write applies to just this one track here.
  const albumTracks = useAlbumTracks(album.id);
  const setTrackKeepOwnCover = useSetTrackKeepOwnCover();
  const openMembership = albumTracks.find((r) => r.track_id === openTrackId);

  const title = album.title ?? t((d) => d.albums.untitled);
  const crumbs: Crumb[] = [
    { id: "albums", name: t((d) => d.nav.albums) },
    { id: String(album.id), name: title },
  ];

  return (
    <div className={styles.view}>
      <div className={styles.header}>
        <Breadcrumb
          crumbs={crumbs}
          atRoot={false}
          onNavigate={(id) => {
            if (id === "albums") onBack();
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
          <AlbumFolderHeader album={album} />
          <div className={styles.tracks}>
            <AlbumTrackList
              albumId={album.id}
              onOpenTrack={setOpenTrackId}
              openTrackId={openTrackId}
            />
          </div>
        </ScrollArea>

        {trackRow ? (
          <div className={styles.panel}>
            <Resizer resizer={resizer} />
            <TrackDetail
              track={trackRow}
              onClose={() => setOpenTrackId(null)}
              albumFallback={{
                album: album.title,
                album_artist: album.album_artist,
                year: album.year,
              }}
              keepOwnCover={
                openMembership
                  ? {
                      value: openMembership.keep_own_cover,
                      onChange: (next) =>
                        void setTrackKeepOwnCover(album.id, [trackRow.id], next),
                    }
                  : undefined
              }
            />
          </div>
        ) : null}
      </div>
    </div>
  );
}
