// -- Framework Imports --
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

// -- Component Imports --
import { AmbientButton } from "./ambient/AmbientButton";
import { AmbientStage } from "./ambient/AmbientStage";
import { Aurora } from "./Aurora";
import { CenteredStage } from "../common/CenteredStage";
import { CoverBackdrop } from "./CoverBackdrop";
import { PlayerHero } from "./PlayerHero";
import { QueueList } from "./QueueList";
import { SoundMenu } from "../sound/SoundMenu";
import { Visualizer } from "./visualizers/Visualizer";

// -- Hook Imports --
import { useTrackCover } from "../tracks/useTrackCover";
import { useVisualizerChoice } from "./visualizers/useVisualizerChoice";

// -- State Imports --
import { useCurrentTrackId } from "../../state/player/store";

// -- Type Imports --
import type { Ref } from "react";
import type { PlaybackSource } from "../../types";

// -- i18n Imports --
import { useT } from "../../i18n";

// -- Style Imports --
import styles from "./PlayerView.module.css";

/**
 * The Player destination: the now-playing hero beside the up-next queue, in a rounded inset panel floating
 * on the ambient ground, with no undo/redo or action-bar chrome. Nothing playing folds to a calm empty
 * stage in the same panel rather than an empty two-column shell, keeping the Sound button since the EQ is
 * a setting that needs no track, and the ambient entry disabled. The one lit accent is the seek fill.
 *
 * Ambient mode lives here too: entering holds the current track as the one on show, and it follows track
 * changes but never drops to nothing, so the last track ending keeps the stage up. Leaving hands focus
 * back to the entry button.
 *
 * `onNavigate` routes the hero's source link back to the library - the shell owns the mode and open-id
 * state, so this only forwards the chosen source.
 */
export function PlayerView({ onNavigate }: { onNavigate: (source: PlaybackSource) => void }) {
  const trackId = useCurrentTrackId();
  const t = useT();
  const [ambientTrack, setAmbientTrack] = useState<number | null>(null);
  const entryRef = useRef<HTMLButtonElement | null>(null);

  useEffect(() => {
    if (trackId != null) setAmbientTrack((held) => (held != null ? trackId : held));
  }, [trackId]);

  const enterAmbient = useCallback(() => setAmbientTrack(trackId), [trackId]);
  const exitAmbient = useCallback(() => {
    setAmbientTrack(null);
    // The app is inert until the stage unmounts, so focus waits a frame.
    requestAnimationFrame(() => entryRef.current?.focus({ preventScroll: true }));
  }, []);

  // The stage sits at one spot in the tree whatever the panel shows, so a queue running out under it
  // never remounts it (and never drops out of full-screen).
  const ambient = ambientTrack != null ? <AmbientStage trackId={ambientTrack} onExit={exitAmbient} /> : null;

  return (
    <>
      {trackId == null ? (
        <div className={styles.panel}>
          <CenteredStage>
            <div className={styles.ghost} aria-hidden="true" />
            <h1 className={styles.emptyTitle}>{t((d) => d.player.nothingPlaying)}</h1>
            <p className={styles.emptyHint}>{t((d) => d.player.nothingPlayingHint)}</p>
          </CenteredStage>
          <div className={styles.emptySound}>
            <SoundMenu />
          </div>
          <div className={styles.emptyAmbient}>
            <AmbientButton disabled />
          </div>
        </div>
      ) : (
        <PlayerStage
          trackId={trackId}
          onNavigate={onNavigate}
          ambient={ambientTrack != null}
          onEnterAmbient={enterAmbient}
          entryRef={entryRef}
        />
      )}
      {ambient}
    </>
  );
}

/**
 * The playing stage: the two columns over the current cover, spread as a soft ambient glow behind both,
 * an aurora of drifting colour blooms above it, and the picked visualizer rising around the cover. Mounts
 * only with a real track id, so its id-typed cover hook never runs empty. The ambient layers sit under the
 * content, which carries the only lit mark. Liquid alone fills the whole panel, so under it the queue
 * takes a frosted backing. While ambient mode is up, the aurora and visualizer stand down here, so only
 * the full-screen stage draws.
 */
function PlayerStage({
  trackId,
  onNavigate,
  ambient,
  onEnterAmbient,
  entryRef,
}: {
  trackId: number;
  onNavigate: (source: PlaybackSource) => void;
  ambient: boolean;
  onEnterAmbient: () => void;
  entryRef: Ref<HTMLButtonElement>;
}) {
  const { cover } = useTrackCover(trackId);
  const coverSrc = cover?.src ?? null;
  // Shared with the aurora and the visualizer so they center on the art.
  const coverRef = useRef<HTMLSpanElement | null>(null);
  // The hero column, which the visualizer feathers off outside so the queue rows stay clear.
  const heroRef = useRef<HTMLDivElement | null>(null);
  // The seek bar, which the visualizer can rest on.
  const seekRef = useRef<HTMLDivElement | null>(null);
  // The source line and the title block, which the visualizer can quiet itself behind.
  const sourceRef = useRef<HTMLDivElement | null>(null);
  const textRef = useRef<HTMLDivElement | null>(null);
  const hushRefs = useMemo(() => [sourceRef, textRef], []);
  const choice = useVisualizerChoice(coverSrc);
  // Liquid and Dot cover draw the art themselves, under a clear tile in place of the cover.
  let drawnArt: "liquid" | "dots" | null = null;
  if (!ambient && choice.kind === "liquid") drawnArt = "liquid";
  else if (!ambient && choice.kind === "dot-cover") drawnArt = "dots";

  return (
    <div className={`${styles.panel} ${styles.view}`}>
      <CoverBackdrop src={coverSrc} className={styles.glow} />
      {ambient ? null : <Aurora trackId={trackId} coverRef={coverRef} />}
      {ambient ? null : (
        <Visualizer
          choice={choice}
          trackId={trackId}
          coverRef={coverRef}
          maskRef={heroRef}
          floorRef={seekRef}
          hushRefs={hushRefs}
        />
      )}
      <div className={styles.content}>
        <PlayerHero
          trackId={trackId}
          onNavigate={onNavigate}
          coverRef={coverRef}
          heroRef={heroRef}
          seekRef={seekRef}
          sourceRef={sourceRef}
          textRef={textRef}
          drawnArt={drawnArt}
          onEnterAmbient={onEnterAmbient}
          ambientRef={entryRef}
        />
        <QueueList frosted={!ambient && choice.kind === "liquid"} />
      </div>
    </div>
  );
}
