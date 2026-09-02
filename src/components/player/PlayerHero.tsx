// -- Icon Imports --
import { Repeat, Repeat1, Shuffle } from "lucide-react";

// -- Component Imports --
import { Cover } from "../common/Cover/Cover";
import { IconToggle } from "../common/IconToggle";
import { CoverBackdrop } from "./CoverBackdrop";
import { SeekBar } from "./SeekBar";
import { Transport } from "./Transport";
import { Volume } from "./Volume";

// -- Hook Imports --
import { useTrackCover } from "../tracks/useTrackCover";
import { useTrackDisplay } from "./useTrackDisplay";

// -- State Imports --
import { usePlayerActions, usePlayerStatus, usePlayingFrom } from "../../state/player/store";

// -- Type Imports --
import type { PlaybackSource, RepeatMode } from "../../types";

// -- i18n Imports --
import { useT } from "../../i18n";

// -- Style Imports --
import styles from "./PlayerHero.module.css";

/** The repeat cycle the button steps through on each press. */
const NEXT_REPEAT: Record<RepeatMode, RepeatMode> = { off: "all", all: "one", one: "off" };

/**
 * The now-playing column: the source line, the cover, the title and artist, the seek bar, the transport
 * flanked by shuffle and repeat, and the volume. Mounts only with a real track id, so its id-typed hooks
 * never run empty. The seek fill is the one lit accent of the whole view; every other control reads by
 * weight and material. A confined whisper of the cover washes behind the column, feathered out well
 * before its right edge - no dark scrim, so this never reads as a player theme.
 */
export function PlayerHero({
  trackId,
  onNavigate,
}: {
  trackId: number;
  onNavigate: (source: PlaybackSource) => void;
}) {
  const { cover } = useTrackCover(trackId);
  const { title, artist } = useTrackDisplay(trackId);
  const status = usePlayerStatus();
  const actions = usePlayerActions();
  const t = useT();
  const coverSrc = cover?.src ?? null;

  return (
    <div className={styles.hero}>
      <CoverBackdrop src={coverSrc} className={styles.wash} />
      <div className={styles.column}>
        <SourceLine onNavigate={onNavigate} />

        <span className={styles.cover}>
          <Cover src={coverSrc} alt="" />
        </span>

        <div className={styles.text}>
          <h1 className={styles.title}>{title ?? t((d) => d.albums.untitled)}</h1>
          <p className={styles.artist}>{artist ?? t((d) => d.albums.unknownArtist)}</p>
        </div>

        <div className={styles.seekWrap}>
          <SeekBar
            position={status.position_secs}
            duration={status.duration_secs}
            onSeek={actions.seek}
          />
        </div>

        <div className={styles.transport}>
          <IconToggle
            pressed={status.shuffle}
            aria-label={t((d) => d.player.shuffle)}
            onClick={() => actions.setShuffle(!status.shuffle)}
          >
            <Shuffle size={18} strokeWidth={1.8} />
          </IconToggle>
          <Transport size="lg" />
          <IconToggle
            pressed={status.repeat !== "off"}
            aria-label={t((d) => d.player.repeat)}
            onClick={() => actions.setRepeat(NEXT_REPEAT[status.repeat])}
          >
            {status.repeat === "one" ? (
              <Repeat1 size={18} strokeWidth={1.8} />
            ) : (
              <Repeat size={18} strokeWidth={1.8} />
            )}
          </IconToggle>
        </div>

        <div className={styles.volume}>
          <Volume volume={status.volume} />
        </div>
      </div>
    </div>
  );
}

/**
 * The "playing from" line: an uppercase micro-label naming the source kind over its name. An album or
 * playlist and the flat library views link to their destination; a lone single names its track without
 * one. Nothing shows before the first play, when the source is still null.
 */
function SourceLine({ onNavigate }: { onNavigate: (source: PlaybackSource) => void }) {
  const source = usePlayingFrom();
  const t = useT();
  if (source == null) return null;

  // The uppercase kind label over the source, and the name shown beneath it. The flat views carry no
  // stored name, so the name is their own localized destination label.
  let label: string;
  let name: string;
  let link = true;
  switch (source.kind) {
    case "album":
      label = `${t((d) => d.player.playingFrom)} ${t((d) => d.player.sourceAlbum)}`;
      name = source.label;
      break;
    case "playlist":
      label = `${t((d) => d.player.playingFrom)} ${t((d) => d.player.sourcePlaylist)}`;
      name = source.label;
      break;
    case "files":
      label = t((d) => d.player.playingFrom);
      name = t((d) => d.player.sourceFiles);
      break;
    case "singles":
      label = t((d) => d.player.playingFrom);
      name = t((d) => d.player.sourceSingles);
      break;
    case "unsorted":
      label = t((d) => d.player.playingFrom);
      name = t((d) => d.player.sourceUnsorted);
      break;
    case "single":
      // A lone track carries a track id, not a container to open, so its name is plain text.
      label = t((d) => d.player.playingFrom);
      name = source.label;
      link = false;
      break;
  }

  return (
    <div className={styles.source}>
      <span className={styles.sourceLabel}>{label}</span>
      {link ? (
        <button type="button" className={styles.sourceName} onClick={() => onNavigate(source)}>
          {name}
        </button>
      ) : (
        <span className={styles.sourceNamePlain}>{name}</span>
      )}
    </div>
  );
}
