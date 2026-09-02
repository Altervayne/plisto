// -- Component Imports --
import { Cover } from "../common/Cover/Cover";
import { CoverBackdrop } from "./CoverBackdrop";
import { PopOutButton } from "./PopOutButton";
import { StopButton } from "./StopButton";
import { Transport } from "./Transport";

// -- Hook Imports --
import { useTrackCover } from "../tracks/useTrackCover";

// -- State Imports --
import { useTrack } from "../../state/store";
import { useCurrentTrackId } from "../../state/player/store";

// -- i18n Imports --
import { useT } from "../../i18n";

// -- Style Imports --
import styles from "./MiniPlayer.module.css";

/**
 * The now-playing mini docked at the foot of the sidebar rail. Nothing shows until the first play:
 * a null track id renders nothing, so the rail stays clean before the engine holds a track. The
 * inner bar reads the track and its cover, so its hooks only run once there is a track to read.
 */
export function MiniPlayer({ onExpand }: { onExpand: () => void }) {
  const trackId = useCurrentTrackId();
  if (trackId == null) return null;
  return <MiniPlayerBar trackId={trackId} onExpand={onExpand} />;
}

/**
 * The bar itself: cover, one text line, and a compact prev / play-pause / next transport. The cover and
 * text area is its own button opening the full Player; the transport buttons below keep their own clicks.
 */
function MiniPlayerBar({ trackId, onExpand }: { trackId: number; onExpand: () => void }) {
  const track = useTrack(trackId);
  const { cover } = useTrackCover(trackId);
  const t = useT();

  const title = track?.title_edit ?? track?.raw_title ?? t((d) => d.albums.untitled);
  const artist = track?.artist_edit ?? track?.raw_artist ?? t((d) => d.albums.unknownArtist);
  const coverSrc = cover?.src ?? null;

  return (
    <div className={styles.mini}>
      <CoverBackdrop src={coverSrc} className={styles.bg} />
      <div className={styles.scrim} />
      <div className={styles.content}>
        <button
          type="button"
          className={styles.now}
          aria-label={t((d) => d.player.openPlayer)}
          onClick={onExpand}
        >
          <span className={styles.cover}>
            <Cover src={coverSrc} alt="" />
          </span>
          <span className={styles.text}>
            <span className={styles.title}>{title}</span>
            <span className={styles.artist}>{artist}</span>
          </span>
        </button>
        <div className={styles.controls}>
          <span className={styles.side}>
            <PopOutButton />
          </span>
          <span className={styles.pill}>
            <Transport />
          </span>
          <span className={styles.side}>
            <StopButton />
          </span>
        </div>
      </div>
    </div>
  );
}
