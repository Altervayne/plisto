// -- Component Imports --
import { CenteredStage } from "../common/CenteredStage";
import { PlayerHero } from "./PlayerHero";
import { QueueList } from "./QueueList";

// -- State Imports --
import { useCurrentTrackId } from "../../state/player/store";

// -- Type Imports --
import type { PlaybackSource } from "../../types";

// -- i18n Imports --
import { useT } from "../../i18n";

// -- Style Imports --
import styles from "./PlayerView.module.css";

/**
 * The Player destination: the now-playing hero beside the up-next queue, over the ambient ground. It owns
 * the whole main region, with no undo/redo or action-bar chrome. Nothing playing folds to a calm empty
 * stage rather than an empty two-column shell. The one lit accent is the seek fill inside the hero.
 *
 * `onNavigate` routes the hero's source link back to the library - the shell owns the mode and open-id
 * state, so this only forwards the chosen source.
 */
export function PlayerView({ onNavigate }: { onNavigate: (source: PlaybackSource) => void }) {
  const trackId = useCurrentTrackId();
  const t = useT();

  if (trackId == null) {
    return (
      <CenteredStage>
        <div className={styles.ghost} aria-hidden="true" />
        <h1 className={styles.emptyTitle}>{t((d) => d.player.nothingPlaying)}</h1>
        <p className={styles.emptyHint}>{t((d) => d.player.nothingPlayingHint)}</p>
      </CenteredStage>
    );
  }

  return (
    <div className={styles.view}>
      <PlayerHero trackId={trackId} onNavigate={onNavigate} />
      <QueueList />
    </div>
  );
}
