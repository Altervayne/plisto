// -- Framework Imports --
import { useRef } from "react";

// -- Component Imports --
import { Cover } from "../common/Cover/Cover";
import { SoundMenu } from "../sound/SoundMenu";
import { CoverBackdrop } from "./CoverBackdrop";
import { PopOutButton } from "./PopOutButton";
import { StopButton } from "./StopButton";
import { Transport } from "./Transport";

// -- Hook Imports --
import { useTrackCover } from "../tracks/useTrackCover";
import { useTrackDisplay } from "./useTrackDisplay";

// -- State Imports --
import { useTrack } from "../../state/store";
import { useCurrentTrackId, usePlayerStore, useSeatedStream } from "../../state/player/store";
import { waitingPhase } from "../../state/player/streamView";

// -- Format Imports --
import { formatDuration } from "../../lib/format";

// -- Local Imports --
import { waitWord } from "./streamWords";

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
 * The bar itself: cover, one text line with the Sound button trailing it, and a compact prev /
 * play-pause / next transport. The cover and text area is its own button opening the full Player and
 * truncates before the Sound button; the transport buttons below keep their own clicks.
 *
 * An ad-hoc file (a negative id) carries no library row, so its text comes from the resolved display over
 * IPC - the title from the stash, the artist hidden when the file has none. A library id keeps the
 * library store and its "Unknown Artist" fallback unchanged.
 *
 * A seated plugin stream reads from the hub instead: the now line or title (or the one static word of a
 * waiting phase) over the plugin's name, with Stop pinned visible. The bar reads only the hub's object, so
 * a position tick re-renders just the elapsed-time span.
 */
function MiniPlayerBar({ trackId, onExpand }: { trackId: number; onExpand: () => void }) {
  const adHoc = trackId < 0;
  const stream = useSeatedStream();
  const track = useTrack(trackId);
  const display = useTrackDisplay(adHoc && !stream ? trackId : null);
  const { cover } = useTrackCover(trackId, false, stream?.art_rev ?? 0);
  const t = useT();

  const wait = stream ? waitingPhase(stream.state) : null;
  const title = stream
    ? wait
      ? waitWord(t, wait)
      : stream.now ?? stream.title
    : adHoc
      ? display.title ?? t((d) => d.albums.untitled)
      : track?.title_edit ?? track?.raw_title ?? t((d) => d.albums.untitled);
  const artist = adHoc
    ? display.artist
    : track?.artist_edit ?? track?.raw_artist ?? t((d) => d.albums.unknownArtist);
  const coverSrc = cover?.src ?? null;
  // The Sound card lines up with the mini's left edge, not the button at the trailing end of the line.
  const miniRef = useRef<HTMLDivElement | null>(null);

  return (
    <div ref={miniRef} className={styles.mini}>
      <CoverBackdrop src={coverSrc} className={styles.bg} />
      <div className={styles.scrim} />
      <div className={styles.content}>
        <div className={styles.nowLine}>
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
              {stream ? (
                <span className={styles.pluginLine}>
                  <span className={styles.pluginName}>{stream.plugin_name}</span>
                  <StreamElapsed />
                  {stream.state === "paused" ? (
                    <span className={styles.pluginTag}>{t((d) => d.player.stream.paused)}</span>
                  ) : null}
                </span>
              ) : artist ? (
                <span className={styles.artist}>{artist}</span>
              ) : null}
            </span>
          </button>
          <span className={styles.sound}>
            <SoundMenu size="sm" alignRef={miniRef} />
          </span>
        </div>
        <div className={styles.controls}>
          <span className={styles.side}>
            <PopOutButton />
          </span>
          <span className={styles.pill}>
            <Transport shortcutHints />
          </span>
          <span className={stream ? `${styles.side} ${styles.sidePinned}` : styles.side}>
            <StopButton />
          </span>
        </div>
      </div>
    </div>
  );
}

/**
 * The elapsed time of a stream item with a known length, as its own subscriber so the bar above never
 * re-renders on a tick. The selector returns a whole second, or -1 with no known length, which renders
 * nothing.
 */
function StreamElapsed() {
  const secs = usePlayerStore((s) =>
    s.status.duration_secs > 0 ? Math.floor(s.status.position_secs) : -1,
  );
  if (secs < 0) return null;
  return <span className={`${styles.pluginTag} tabular`}>{formatDuration(secs)}</span>;
}
