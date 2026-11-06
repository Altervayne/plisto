// -- Framework Imports --
import { useEffect, useRef } from "react";

// -- Component Imports --
import { AlbumGrid } from "../albums/AlbumGrid";
import { AlbumDrawer } from "../albums/AlbumDrawer";
import { AlbumFolderView } from "../albums/AlbumFolderView";
import { AllTracksView } from "../tracks/AllTracksView";
import { EmptyState } from "../common/EmptyState";
import { Resizer } from "../common/Resizer/Resizer";

// -- Hook Imports --
import { useMountTransition } from "../../hooks/useMountTransition";

// -- State Imports --
import {
  useCloseCollectionFull,
  useCollectionDrawerAlbumId,
  useCollectionFullAlbumId,
  useOpenCollectionFull,
  useSetCollectionDrawer,
} from "../../state/collection/store";

// -- Type Imports --
import type { CollectionSegment } from "../../state/collection/store";
import type { ResizerControl } from "../common/Resizer/resizerTypes";
import type { AlbumRow } from "../../types";

// -- i18n Imports --
import { useT } from "../../i18n";

// -- Style Imports --
import styles from "./CollectionView.module.css";

/** The drawer content's exit before the panel unmounts, matching --dur-soft on the exit keyframe. */
const DRAWER_EXIT_MS = 200;

/** The full pane's fade-out before it unmounts, matching --dur-fast on the exit keyframe. */
const VIEW_EXIT_MS = 120;

/**
 * The Collection's body for the segment in view: the album wall with its drawer and full pane, the
 * singles wall with its drawer, All tracks, or Browse. One drawer id serves both walls; each resolves
 * it against its own bucket, so a stale id from the other wall never opens a drawer here. The full pane
 * is scoped to albums, and a deleted id closes it rather than stranding the wall under it.
 */
export function CollectionView({
  segment,
  albums,
  singles,
  resizer,
}: {
  segment: CollectionSegment;
  albums: AlbumRow[];
  singles: AlbumRow[];
  resizer: ResizerControl;
}) {
  const t = useT();
  const drawerAlbumId = useCollectionDrawerAlbumId();
  const fullAlbumId = useCollectionFullAlbumId();
  const setDrawer = useSetCollectionDrawer();
  const openFull = useOpenCollectionFull();
  const closeFull = useCloseCollectionFull();

  const selectedAlbum = albums.find((a) => a.id === drawerAlbumId) ?? null;
  const selectedSingle = singles.find((a) => a.id === drawerAlbumId) ?? null;
  const openAlbum = albums.find((a) => a.id === fullAlbumId) ?? null;
  useEffect(() => {
    if (fullAlbumId != null && openAlbum == null) closeFull();
  }, [fullAlbumId, openAlbum, closeFull]);

  // Hold each drawer through its exit after the selection clears. The panel width snaps; only the
  // drawer content transform-fades. The selection is already null by then, so a ref keeps the last
  // album to render during the fade rather than showing an empty panel.
  const albumDrawer = useMountTransition(selectedAlbum != null, DRAWER_EXIT_MS);
  const lastAlbum = useRef<AlbumRow | null>(null);
  if (selectedAlbum) lastAlbum.current = selectedAlbum;
  const singleDrawer = useMountTransition(selectedSingle != null, DRAWER_EXIT_MS);
  const lastSingle = useRef<AlbumRow | null>(null);
  if (selectedSingle) lastSingle.current = selectedSingle;

  // Hold the full pane through its fade-out, retaining the last album so it renders during the exit
  // once its id has cleared.
  const fullPane = useMountTransition(openAlbum != null, VIEW_EXIT_MS);
  const lastOpenAlbum = useRef<AlbumRow | null>(null);
  if (openAlbum) lastOpenAlbum.current = openAlbum;

  const closeDrawer = () => setDrawer(null);

  if (segment === "browse") {
    return (
      <EmptyState
        tone="idle"
        title={t((d) => d.collection.browsePendingTitle)}
        line={t((d) => d.collection.browsePendingLine)}
      />
    );
  }

  if (segment === "tracks") return <AllTracksView />;

  if (segment === "singles") {
    return (
      <>
        <AlbumGrid
          albums={singles}
          selectedAlbumId={drawerAlbumId}
          onOpen={setDrawer}
          emptyTitle={t((d) => d.singles.emptyTitle)}
          emptyLine={t((d) => d.singles.emptyLine)}
        />
        {singleDrawer.mounted && lastSingle.current ? (
          <div className={styles.panel}>
            <Resizer resizer={resizer} />
            <AlbumDrawer
              album={lastSingle.current}
              state={singleDrawer.state}
              onClose={closeDrawer}
            />
          </div>
        ) : null}
      </>
    );
  }

  return (
    <>
      {/* The grid holds the flow and fades under the full pane; the pane overlays it and crossfades in.
          `inert` while it is under keeps keyboard focus out of the hidden cards, which opacity +
          pointer-events alone would leave in the tab order. */}
      <div
        className={styles.gridLayer}
        data-under={openAlbum != null ? "" : undefined}
        inert={openAlbum != null || undefined}
      >
        <AlbumGrid
          albums={albums}
          selectedAlbumId={drawerAlbumId}
          onOpen={setDrawer}
          onOpenFull={openFull}
        />
        {albumDrawer.mounted && lastAlbum.current ? (
          <div className={styles.panel}>
            <Resizer resizer={resizer} />
            <AlbumDrawer
              album={lastAlbum.current}
              state={albumDrawer.state}
              onClose={closeDrawer}
              onOpenFull={openFull}
            />
          </div>
        ) : null}
      </div>
      {/* Mount the pane the same render the grid starts dimming, not a frame later: keying render on
          the live id (plus the exit hold) closes the gap where the grid showed undimmed with no
          overlay. data-state rides the live id too, so enter plays at once. */}
      {(openAlbum != null || fullPane.mounted) && lastOpenAlbum.current ? (
        <div className={styles.fullLayer} data-state={openAlbum != null ? "enter" : "exit"}>
          <AlbumFolderView album={openAlbum ?? lastOpenAlbum.current} onBack={closeFull} />
        </div>
      ) : null}
    </>
  );
}
