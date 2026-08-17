// -- Framework Imports --
import { memo, useCallback, useEffect, useMemo, useState } from "react";

// -- Icon Imports --
import { ImagePlus, Wand2 } from "lucide-react";

// -- Component Imports --
import { Cover } from "../common/Cover/Cover";
import { ImageTile } from "./ImageTile";
import { CoverTrackChecklist } from "./CoverTrackChecklist";
import { CoverMatchPreview } from "./CoverMatchPreview";

// -- Hook Imports --
import { invalidateAlbumCover, useAlbumCover } from "../albums/useAlbumCover";
import { useTrackThumb } from "./useTrackThumb";
import { useFolderTracks } from "./useFolderTracks";

// -- Unit Imports --
import { matchStemPairs } from "./matchCovers";

// -- State Imports --
import { useMarkFolderCovered } from "../../state/covers/store";

// -- IPC Imports --
import { importFolderCoverByPath, setAlbumCover } from "../../lib/ipc";

// -- Utils Imports --
import { pickImageFile } from "../../lib/dialog";

// -- Type Imports --
import type { ImageFolderGroup } from "../../types";

// -- i18n Imports --
import { useT } from "../../i18n";

// -- Style Imports --
import styles from "./FolderCoverRow.module.css";

/** The ancestor path above a folder's leaf, forward-slashed, for the quiet path tail under its name. */
function ancestorTail(folderPath: string): string {
  const segs = folderPath.split(/[\\/]/).filter(Boolean);
  segs.pop();
  return segs.join("/");
}

/**
 * One folder group in the triage: its identity and cover-state on the left, its loose images on the
 * right. The recessed cover-state is the demand signal - a hollow tile means the folder resolves to no
 * cover; the strip is the supply. Clicking an image opens the chooser to bind it as the folder cover,
 * the album cover (only when the folder resolves to one album), or a picked subset of tracks. A folder
 * with no loose images still shows, with the sanctioned disk-import fallback. Binding folder-wide flips
 * the group's needs-cover state at once and rings the bound tile.
 *
 * Memoized on the group, which only changes for the folder whose state flips, so a bind never re-renders
 * the rest of the wall.
 */
export const FolderCoverRow = memo(function FolderCoverRow({ group }: { group: ImageFolderGroup }) {
  const t = useT();
  const markFolderCovered = useMarkFolderCovered();
  const folderTracks = useFolderTracks(group.folder_path);

  // The image bound as the folder cover this session, ringed in the strip. The pre-existing binding is a
  // cached copy with no source path to match, so the ring lights only after an assign here.
  const [boundPath, setBoundPath] = useState<string | null>(null);
  // Which image the specific-tracks checklist is binding, or null when collapsed.
  const [checklistPath, setChecklistPath] = useState<string | null>(null);
  // Bumped after an album-cover bind to remount this row's album tiles, so they refetch the fresh art.
  const [albumNonce, setAlbumNonce] = useState(0);
  // Whether the filename-match preview scoped to this folder is open.
  const [matchOpen, setMatchOpen] = useState(false);
  // How many covers the last folder match landed, shown briefly then cleared.
  const [matched, setMatched] = useState<number | null>(null);

  const albumId = group.album?.id ?? null;
  const ancestor = ancestorTail(group.folder_path);

  // The filename pairs for this folder: each loose image whose stem equals a track's stem here.
  const matches = useMemo(
    () => matchStemPairs(group.images, folderTracks),
    [group.images, folderTracks],
  );

  // The applied notice fades on its own after a moment; a fresh apply restarts the timer.
  useEffect(() => {
    if (matched == null) return;
    const id = window.setTimeout(() => setMatched(null), 4000);
    return () => window.clearTimeout(id);
  }, [matched]);

  const onSetFolderCover = useCallback(
    async (path: string) => {
      try {
        await importFolderCoverByPath(group.folder_path, path);
        setBoundPath(path);
        markFolderCovered(group.folder_path);
      } catch {
        // A failed bind stays quiet: the folder simply keeps its state, nothing to undo.
      }
    },
    [group.folder_path, markFolderCovered],
  );

  const onSetAlbumCover = useCallback(
    async (path: string) => {
      if (albumId == null) return;
      try {
        await setAlbumCover(albumId, path);
        invalidateAlbumCover(albumId);
        setAlbumNonce((n) => n + 1);
      } catch {
        // Quiet on failure, as above.
      }
    },
    [albumId],
  );

  const onSetSpecificTracks = useCallback((path: string) => setChecklistPath(path), []);

  const replaceFromDisk = async () => {
    const path = await pickImageFile();
    if (!path) return;
    await onSetFolderCover(path);
  };

  return (
    <div className={styles.row}>
      <div className={styles.left}>
        <div className={styles.state}>
          <CoverStateTile group={group} folderTrackId={folderTracks[0]?.id ?? null} nonce={albumNonce} />
        </div>
        <div className={styles.identity}>
          <span className={styles.name}>{group.folder_name}</span>
          {ancestor ? <span className={styles.path}>{ancestor}</span> : null}
          <div className={styles.meta}>
            <span className={styles.count}>
              {group.track_count > 0
                ? t((d) => d.covers.trackCount, { n: group.track_count })
                : t((d) => d.covers.noTracks)}
            </span>
            {group.album ? (
              <span className={styles.album}>
                <span className={styles.albumThumb}>
                  <AlbumThumb key={albumNonce} albumId={group.album.id} />
                </span>
                <span className={styles.albumTitle}>
                  {group.album.title ?? t((d) => d.albums.untitled)}
                </span>
              </span>
            ) : null}
          </div>
        </div>
      </div>

      <div className={styles.supply}>
        {group.images.length > 0 ? (
          <div className={styles.strip}>
            {group.images.map((path) => (
              <ImageTile
                key={path}
                path={path}
                inUse={path === boundPath}
                trackCount={group.track_count}
                albumId={albumId}
                onSetFolderCover={onSetFolderCover}
                onSetAlbumCover={onSetAlbumCover}
                onSetSpecificTracks={onSetSpecificTracks}
              />
            ))}
          </div>
        ) : (
          <div className={styles.noImages}>
            <span className={styles.noImagesLine}>{t((d) => d.covers.noLooseImages)}</span>
            <button type="button" className={styles.diskButton} onClick={() => void replaceFromDisk()}>
              <ImagePlus size={15} strokeWidth={1.8} />
              {t((d) => d.covers.replaceFromDisk)}
            </button>
          </div>
        )}

        {matches.length > 0 ? (
          <div className={styles.matchBar}>
            <button
              type="button"
              className={styles.matchButton}
              onClick={() => setMatchOpen(true)}
            >
              <Wand2 size={14} strokeWidth={1.8} />
              {t((d) => d.covers.matchFolder, { n: matches.length })}
            </button>
            {matched != null ? (
              <span className={styles.matchNotice}>
                {t((d) => d.covers.matchedNotice, { n: matched })}
              </span>
            ) : null}
          </div>
        ) : null}

        {checklistPath ? (
          <CoverTrackChecklist
            tracks={folderTracks}
            imagePath={checklistPath}
            onClose={() => setChecklistPath(null)}
          />
        ) : null}

        {matchOpen ? (
          <CoverMatchPreview
            matches={matches}
            onClose={() => setMatchOpen(false)}
            onApplied={(count) => {
              setMatchOpen(false);
              setMatched(count);
              // Every track in the folder just got its own cover, so none is bare any more: drop the
              // folder from the Needs-cover list at once rather than waiting on a manual refresh.
              if (folderTracks.length > 0 && count === folderTracks.length) {
                markFolderCovered(group.folder_path);
              }
            }}
          />
        ) : null}
      </div>
    </div>
  );
});

/**
 * The cover-state tile: a hollow recess when the folder still needs a cover - the demand signal itself -
 * else the calm resolved art. A resolved folder shows its album cover when it maps to one album, else a
 * member track's cover. An audio-less resolved folder has no local art source, so it rests on the recess.
 */
function CoverStateTile({
  group,
  folderTrackId,
  nonce,
}: {
  group: ImageFolderGroup;
  folderTrackId: number | null;
  nonce: number;
}) {
  if (group.needs_cover) return <Cover src={null} alt="" />;
  if (group.album) return <AlbumThumb key={nonce} albumId={group.album.id} />;
  if (folderTrackId != null) return <TrackThumb trackId={folderTrackId} />;
  return <Cover src={null} alt="" />;
}

/** An album's resolved cover as a plain calm tile. */
function AlbumThumb({ albumId }: { albumId: number }) {
  const { src } = useAlbumCover(albumId, "thumb");
  return <Cover src={src} alt="" />;
}

/** A track's resolved cover as a plain calm tile. */
function TrackThumb({ trackId }: { trackId: number }) {
  const src = useTrackThumb(trackId);
  return <Cover src={src} alt="" />;
}
