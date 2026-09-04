// -- Framework Imports --
import type { ReactNode } from "react";

// -- Icon Imports --
import { FileX2 } from "lucide-react";

// -- Component Imports --
import { Cover } from "../common/Cover/Cover";
import { QuietButton } from "../common/QuietButton";
import { CoverBackdrop } from "./CoverBackdrop";
import { SeekBar } from "./SeekBar";
import { SpectrumRidge } from "./SpectrumRidge";
import { Transport } from "./Transport";
import { Volume } from "./Volume";

// -- Hook Imports --
import { useTrackCover } from "../tracks/useTrackCover";
import { useTrackDisplay } from "./useTrackDisplay";

// -- State Imports --
import { usePlayerActions, usePlayerStatus } from "../../state/player/store";

// -- i18n Imports --
import { useT } from "../../i18n";

// -- Style Imports --
import styles from "./StandaloneCard.module.css";

/** How tall the volume rail reveals in the compact window, shortened so it never clips the card. */
const RAIL_HEIGHT = 64;

/**
 * The compact standalone player's card: the current ad-hoc track over the blurred-cover ground and the
 * spectrum ridge, with the seek bar, the prev/play-pause/next transport and a hover-reveal volume rail.
 * The full ambient treatment is kept so the card feels of-a-piece with the pop-out and the full player.
 * It mounts before the first track arrives (a null id shows the ambient shell without any dishonest idle
 * text), then fills in once the engine holds the track.
 */
export function StandaloneCard({ trackId, total }: { trackId: number | null; total: number }) {
  if (trackId == null) {
    return (
      <CardFrame coverSrc={null}>
        <span className={styles.cover}>
          <Cover src={null} alt="" />
        </span>
        <div className={styles.main} />
      </CardFrame>
    );
  }
  return <PlayingCard trackId={trackId} total={total} />;
}

/**
 * The playing body: cover, title and the artist (hidden when the file carries none), an optional
 * position counter across several files, the seek bar and the transport with the volume rail. Mounts
 * only with a real track id, so its id-typed hooks never run empty.
 */
function PlayingCard({ trackId, total }: { trackId: number; total: number }) {
  const { cover } = useTrackCover(trackId);
  const { title, artist } = useTrackDisplay(trackId);
  const status = usePlayerStatus();
  const actions = usePlayerActions();

  return (
    <CardFrame coverSrc={cover?.src ?? null}>
      <span className={styles.cover}>
        <Cover src={cover?.src ?? null} alt="" />
      </span>
      <div className={styles.main}>
        <div className={styles.text}>
          <span className={styles.title}>{title ?? ""}</span>
          {artist ? <span className={styles.artist}>{artist}</span> : null}
          {/* A dim N / M counter only when several files are queued; prev/next enabled is the other cue. */}
          {total > 1 ? (
            <span className={styles.counter}>
              {status.queue_index + 1} / {total}
            </span>
          ) : null}
        </div>
        <SeekBar
          position={status.position_secs}
          duration={status.duration_secs}
          onSeek={actions.seek}
        />
        <div className={styles.controls}>
          <div className={styles.transport}>
            <Transport size="md" />
          </div>
          <div className={styles.vol}>
            <Volume volume={status.volume} railHeight={RAIL_HEIGHT} />
          </div>
        </div>
      </div>
    </CardFrame>
  );
}

/**
 * The failure body, shown when the handed file cannot play at all: a muted icon over the localized line
 * and the file's own name, honest that the file was refused rather than the idle "nothing playing"
 * placeholder. The library escape sits beneath it; the title bar's close is always there too.
 */
export function StandaloneErrorCard({
  stem,
  onOpenLibrary,
}: {
  stem: string;
  onOpenLibrary: () => void;
}) {
  const t = useT();

  return (
    <div className={styles.card}>
      <CoverBackdrop src={null} className={styles.bg} />
      <div className={styles.scrim} />
      <div className={styles.error}>
        <FileX2 className={styles.errorIcon} size={30} strokeWidth={1.5} aria-hidden="true" />
        <span className={styles.errorTitle}>{t((d) => d.player.cantPlayFile)}</span>
        <span className={styles.errorStem}>{stem}</span>
        <span className={styles.errorAction}>
          <QuietButton onClick={onOpenLibrary}>{t((d) => d.window.openLibrary)}</QuietButton>
        </span>
      </div>
    </div>
  );
}

/** The shared ambient shell: the blurred-cover ground, the dark scrim and the spectrum ridge behind the
 * foreground content, so the playing and loading states carry the same ground. */
function CardFrame({ coverSrc, children }: { coverSrc: string | null; children: ReactNode }) {
  return (
    <div className={styles.card}>
      <CoverBackdrop src={coverSrc} className={styles.bg} />
      <div className={styles.scrim} />
      <SpectrumRidge />
      <div className={styles.content}>{children}</div>
    </div>
  );
}
