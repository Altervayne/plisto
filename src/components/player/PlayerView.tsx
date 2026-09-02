// -- Component Imports --
import { CenteredStage } from "../common/CenteredStage";
import { CoverBackdrop } from "./CoverBackdrop";
import { PlayerHero } from "./PlayerHero";
import { QueueList } from "./QueueList";
import { SpectrumRidge } from "./SpectrumRidge";

// -- Hook Imports --
import { useTrackCover } from "../tracks/useTrackCover";

// -- State Imports --
import { useCurrentTrackId } from "../../state/player/store";

// -- Type Imports --
import type { PlaybackSource } from "../../types";

// -- i18n Imports --
import { useT } from "../../i18n";

// -- Style Imports --
import styles from "./PlayerView.module.css";

/**
 * The Player destination: the now-playing hero beside the up-next queue, in a rounded inset panel floating
 * on the ambient ground, with no undo/redo or action-bar chrome. Nothing playing folds to a calm empty
 * stage in the same panel rather than an empty two-column shell. The one lit accent is the seek fill.
 *
 * `onNavigate` routes the hero's source link back to the library - the shell owns the mode and open-id
 * state, so this only forwards the chosen source.
 */
export function PlayerView({ onNavigate }: { onNavigate: (source: PlaybackSource) => void }) {
  const trackId = useCurrentTrackId();
  const t = useT();

  if (trackId == null) {
    return (
      <div className={styles.panel}>
        <CenteredStage>
          <div className={styles.ghost} aria-hidden="true" />
          <h1 className={styles.emptyTitle}>{t((d) => d.player.nothingPlaying)}</h1>
          <p className={styles.emptyHint}>{t((d) => d.player.nothingPlayingHint)}</p>
        </CenteredStage>
      </div>
    );
  }

  return <PlayerStage trackId={trackId} onNavigate={onNavigate} />;
}

/**
 * The playing stage: the two columns over the current cover, spread as a soft ambient glow behind both and
 * a filled ridge rising from the floor. Mounts only with a real track id, so its id-typed cover hook never
 * runs empty. The glow and ridge sit under the content, which carries the only lit mark.
 */
function PlayerStage({
  trackId,
  onNavigate,
}: {
  trackId: number;
  onNavigate: (source: PlaybackSource) => void;
}) {
  const { cover } = useTrackCover(trackId);
  const coverSrc = cover?.src ?? null;

  return (
    <div className={`${styles.panel} ${styles.view}`}>
      <CoverBackdrop src={coverSrc} className={styles.glow} />
      <SpectrumRidge />
      <div className={styles.content}>
        <PlayerHero trackId={trackId} onNavigate={onNavigate} />
        <QueueList />
      </div>
    </div>
  );
}
