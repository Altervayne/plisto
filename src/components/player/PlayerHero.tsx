// -- Component Imports --
import { AmbientButton } from "./ambient/AmbientButton";
import { Cover } from "../common/Cover/Cover";
import { IconButton } from "../common/IconButton";
import { Tooltip } from "../common/Tooltip";
import { SoundMenu } from "../sound/SoundMenu";
import { SeekBar } from "./SeekBar";
import { SequenceToggle } from "./SequenceToggle";
import { Transport } from "./Transport";
import { VisualizerButton } from "./VisualizerButton";
import { Volume } from "./Volume";

// -- Icon Imports --
import { Square } from "lucide-react";

// -- Hook Imports --
import { useTrackCover } from "../tracks/useTrackCover";
import { transportOrder, useFoldedRow } from "./useFoldedRow";
import { useTrackDisplay } from "./useTrackDisplay";

// -- State Imports --
import {
  usePlayerActions,
  usePlayerStatus,
  usePlayingFrom,
  useSeatedStream,
} from "../../state/player/store";
import { showsScrubber, streamLines, waitingPhase } from "../../state/player/streamView";
import { useRequestPluginPage } from "../../state/shell/store";

// -- Local Imports --
import { waitWord } from "./streamWords";

// -- Type Imports --
import type { Ref, RefObject } from "react";
import type { PlaybackSource, StreamNow } from "../../types";

// -- i18n Imports --
import { useT } from "../../i18n";

// -- Style Imports --
import styles from "./PlayerHero.module.css";

/**
 * The now-playing column: the source line, the cover, the title and artist, the seek bar, and the
 * transport row: the Sound and visualizer buttons leading, shuffle and repeat flanking the previous, play
 * and next cluster, and Stop (stream only), the ambient entry and the volume rail trailing. Below a narrow
 * controls width the row folds to two lines, the cluster over the leading and trailing groups, and the
 * DOM order follows the lines so Tab does too. Mounts only with a real track id, so its id-typed hooks
 * never run empty. The seek fill is the one lit accent
 * of the view; every other control reads by weight and material. Under the Liquid and Dot cover
 * visualizers the art is drawn by the visualizer beneath a clear tile that keeps the cover's shadow, and
 * the real cover crossfades with it through the stage's dip.
 *
 * A seated plugin stream swaps the content, not the layout: the source line names the plugin (linking to
 * its page), the plugin's now line or title leads, a scrubber shows only for an item that is seekable
 * with a known length (else the listened time stands in its place), Stop leads the trailing group, and the
 * shuffle and repeat toggles dim.
 */
export function PlayerHero({
  trackId,
  onNavigate,
  coverRef,
  heroRef,
  seekRef,
  sourceRef,
  textRef,
  drawnArt = null,
  legible = false,
  onEnterAmbient,
  ambientRef,
  noticeHere = true,
}: {
  trackId: number;
  onNavigate: (source: PlaybackSource) => void;
  // Handed up to the aurora and the visualizer so they center on the art.
  coverRef?: RefObject<HTMLSpanElement | null>;
  // The column's box, which the visualizer feathers off outside so the queue stays clear.
  heroRef?: RefObject<HTMLDivElement | null>;
  // The seek bar's wrapper, which the visualizer rests on.
  seekRef?: RefObject<HTMLDivElement | null>;
  // The source line and the title block, which the visualizer quiets itself behind.
  sourceRef?: RefObject<HTMLDivElement | null>;
  textRef?: RefObject<HTMLDivElement | null>;
  // Which visualizer draws the art itself, if any.
  drawnArt?: "liquid" | "dots" | null;
  // A visualizer runs behind the column: the secondary lines and glyphs take full ink and a denser halo.
  legible?: boolean;
  onEnterAmbient?: () => void;
  ambientRef?: Ref<HTMLButtonElement>;
  // False where the flash notice is not drawn (the compact window), so the visualizer button points to the Player.
  noticeHere?: boolean;
}) {
  const stream = useSeatedStream();
  const { cover } = useTrackCover(trackId, false, stream?.art_rev ?? 0);
  const { title, artist } = useTrackDisplay(stream ? null : trackId);
  const status = usePlayerStatus();
  const actions = usePlayerActions();
  const t = useT();
  const coverSrc = cover?.src ?? null;
  const lines = stream ? streamLines(stream) : null;
  const wait = stream ? waitingPhase(stream.state) : null;
  const scrubbable = stream ? showsScrubber(stream, status.duration_secs) : true;
  // One static word for every waiting phase: between the times of a scrubbable item, in the listened slot
  // of any other.
  const note = wait ? waitWord(t, wait) : null;
  const [controlsRef, folded] = useFoldedRow();
  const slots = {
    sound: (
      <div key="sound" className={styles.soundSlot}>
        <SoundMenu />
        <VisualizerButton noticeHere={noticeHere} />
      </div>
    ),
    cluster: (
      <div key="cluster" className={styles.cluster}>
        <SequenceToggle kind="shuffle" />
        <Transport size="lg" shortcutHints />
        <SequenceToggle kind="repeat" />
      </div>
    ),
    volume: (
      <div key="volume" className={styles.volumeSlot}>
        {stream ? (
          <Tooltip label={t((d) => d.player.stop)}>
            <IconButton aria-label={t((d) => d.player.stop)} onClick={() => actions.stop()}>
              <Square size={18} strokeWidth={1.8} />
            </IconButton>
          </Tooltip>
        ) : null}
        {onEnterAmbient ? <AmbientButton ref={ambientRef} onEnter={onEnterAmbient} /> : null}
        <Volume volume={status.volume} shortcutHints />
      </div>
    ),
  };

  return (
    <div ref={heroRef} className={styles.hero}>
      <div className={styles.column} data-legible={legible ? "" : undefined}>
        {/* The identity - source, cover, title - centers in the flexible upper space. */}
        <div className={styles.identity}>
          {stream ? (
            <StreamSourceLine stream={stream} sourceRef={sourceRef} />
          ) : (
            <SourceLine onNavigate={onNavigate} sourceRef={sourceRef} />
          )}

          <span ref={coverRef} className={styles.cover}>
            <span className={styles.coverArt} data-drawn={drawnArt ? "" : undefined}>
              <Cover src={coverSrc} alt="" />
            </span>
            {drawnArt ? (
              <span className={drawnArt === "dots" ? styles.dotTile : styles.liquidTile} aria-hidden="true" />
            ) : null}
          </span>

          <div ref={textRef} className={styles.text}>
            <h1 className={styles.title}>{lines ? lines.first : title ?? t((d) => d.albums.untitled)}</h1>
            {/* The second line of a stream is empty, not absent, so the centred block never jumps. */}
            <p className={styles.artist}>
              {lines ? (lines.second ?? " ") : (artist ?? t((d) => d.albums.unknownArtist))}
            </p>
          </div>
        </div>

        {/* The seek bar and transport sit at the foot of the column. */}
        <div ref={controlsRef} className={styles.controls}>
          <div ref={seekRef} className={styles.seekWrap}>
            <SeekBar
              position={status.position_secs}
              duration={status.duration_secs}
              onSeek={actions.seek}
              listenedOnly={!scrubbable}
              note={note}
            />
          </div>

          {/* DOM order follows the drawn lines, so Tab reads the first line, then the second. */}
          <div className={styles.transport}>{transportOrder(folded).map((slot) => slots[slot])}</div>
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
function SourceLine({
  onNavigate,
  sourceRef,
}: {
  onNavigate: (source: PlaybackSource) => void;
  sourceRef?: RefObject<HTMLDivElement | null>;
}) {
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
    <div ref={sourceRef} className={styles.source}>
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

/**
 * The source line of a plugin stream: the "Streaming from" micro-label over the plugin's name, which links
 * to the plugin's own page as an album name links to its album. The shell drops the request when the
 * plugin is not drawn in the rail.
 */
function StreamSourceLine({
  stream,
  sourceRef,
}: {
  stream: StreamNow;
  sourceRef?: RefObject<HTMLDivElement | null>;
}) {
  const requestPage = useRequestPluginPage();
  const t = useT();

  return (
    <div ref={sourceRef} className={styles.source}>
      <span className={styles.sourceLabel}>{t((d) => d.player.stream.streamingFrom)}</span>
      {stream.plugin_id ? (
        <button type="button" className={styles.sourceName} onClick={() => requestPage(stream.plugin_id, null)}>
          {stream.plugin_name}
        </button>
      ) : null}
    </div>
  );
}
