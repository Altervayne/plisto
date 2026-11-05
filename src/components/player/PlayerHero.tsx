// -- Component Imports --
import { AmbientButton } from "./ambient/AmbientButton";
import { Cover } from "../common/Cover/Cover";
import { SoundMenu } from "../sound/SoundMenu";
import { SeekBar } from "./SeekBar";
import { Transport } from "./Transport";
import { Volume } from "./Volume";

// -- Hook Imports --
import { useTrackCover } from "../tracks/useTrackCover";
import { useTrackDisplay } from "./useTrackDisplay";

// -- State Imports --
import { usePlayerActions, usePlayerStatus, usePlayingFrom } from "../../state/player/store";

// -- Type Imports --
import type { Ref, RefObject } from "react";
import type { PlaybackSource } from "../../types";

// -- i18n Imports --
import { useT } from "../../i18n";

// -- Style Imports --
import styles from "./PlayerHero.module.css";

/**
 * The now-playing column: the source line, the cover, the title and artist, the seek bar, and the
 * transport with the Sound button leading it and the ambient entry and volume rail trailing it. Mounts
 * only with a real track id, so its id-typed hooks never run empty. The seek fill is the one lit accent
 * of the view; every other control reads by weight and material. Under the Liquid visualizer the art is
 * drawn by the visualizer beneath a clear tile that keeps the cover's shadow.
 */
export function PlayerHero({
  trackId,
  onNavigate,
  coverRef,
  heroRef,
  liquid = false,
  onEnterAmbient,
  ambientRef,
}: {
  trackId: number;
  onNavigate: (source: PlaybackSource) => void;
  // Handed up to the aurora and the visualizer so they center on the art.
  coverRef?: RefObject<HTMLSpanElement | null>;
  // The column's box, which the visualizer feathers off outside so the queue stays clear.
  heroRef?: RefObject<HTMLDivElement | null>;
  liquid?: boolean;
  onEnterAmbient?: () => void;
  ambientRef?: Ref<HTMLButtonElement>;
}) {
  const { cover } = useTrackCover(trackId);
  const { title, artist } = useTrackDisplay(trackId);
  const status = usePlayerStatus();
  const actions = usePlayerActions();
  const t = useT();
  const coverSrc = cover?.src ?? null;

  return (
    <div ref={heroRef} className={styles.hero}>
      <div className={styles.column}>
        {/* The identity - source, cover, title - centers in the flexible upper space. */}
        <div className={styles.identity}>
          <SourceLine onNavigate={onNavigate} />

          <span ref={coverRef} className={styles.cover}>
            {liquid ? <span className={styles.liquidTile} aria-hidden="true" /> : <Cover src={coverSrc} alt="" />}
          </span>

          <div className={styles.text}>
            <h1 className={styles.title}>{title ?? t((d) => d.albums.untitled)}</h1>
            <p className={styles.artist}>{artist ?? t((d) => d.albums.unknownArtist)}</p>
          </div>
        </div>

        {/* The seek bar and transport sit at the foot of the column. */}
        <div className={styles.controls}>
          <div className={styles.seekWrap}>
            <SeekBar
              position={status.position_secs}
              duration={status.duration_secs}
              onSeek={actions.seek}
            />
          </div>

          <div className={styles.transport}>
            <div className={styles.soundSlot}>
              <SoundMenu />
            </div>
            <div className={styles.cluster}>
              <Transport size="lg" shortcutHints />
            </div>
            <div className={styles.volumeSlot}>
              {onEnterAmbient ? <AmbientButton ref={ambientRef} onEnter={onEnterAmbient} /> : null}
              <Volume volume={status.volume} shortcutHints />
            </div>
          </div>
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
    case "tracks":
      label = t((d) => d.player.playingFrom);
      name = t((d) => d.player.sourceTracks);
      break;
    case "singles":
      label = t((d) => d.player.playingFrom);
      name = t((d) => d.player.sourceSingles);
      break;
    case "unsorted":
      label = t((d) => d.player.playingFrom);
      name = t((d) => d.player.sourceUnsorted);
      break;
    case "history":
      label = t((d) => d.player.playingFrom);
      name = t((d) => d.player.sourceHistory);
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
