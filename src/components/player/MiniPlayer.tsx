// -- Component Imports --
import { Cover } from "../common/Cover/Cover";
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
export function MiniPlayer() {
  const trackId = useCurrentTrackId();
  if (trackId == null) return null;
  return <MiniPlayerBar trackId={trackId} />;
}

/** The bar itself: cover, one text line, and a compact prev / play-pause / next transport. */
function MiniPlayerBar({ trackId }: { trackId: number }) {
  const track = useTrack(trackId);
  const { cover } = useTrackCover(trackId);
  const t = useT();

  const title = track?.title_edit ?? track?.raw_title ?? t((d) => d.albums.untitled);
  const artist = track?.artist_edit ?? track?.raw_artist ?? t((d) => d.albums.unknownArtist);

  return (
    <div className={styles.mini}>
      <div className={styles.now}>
        <span className={styles.cover}>
          <Cover src={cover?.src ?? null} alt="" />
        </span>
        <span className={styles.text}>
          <span className={styles.title}>{title}</span>
          <span className={styles.artist}>{artist}</span>
        </span>
      </div>
      <Transport />
    </div>
  );
}
