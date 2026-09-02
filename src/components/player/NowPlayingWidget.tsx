// -- Framework Imports --
import { useEffect } from "react";
import type { ReactNode } from "react";

// -- Icon Imports --
import { Repeat, Repeat1, X } from "lucide-react";

// -- Component Imports --
import { Cover } from "../common/Cover/Cover";
import { IconButton } from "../common/IconButton";
import { IconToggle } from "../common/IconToggle";
import { CoverBackdrop } from "./CoverBackdrop";
import { SeekBar } from "./SeekBar";
import { SpectrumRidge } from "./SpectrumRidge";
import { Transport } from "./Transport";
import { Volume } from "./Volume";

// -- Local Imports --
import { nextRepeat } from "./sequenceState";

// -- Hook Imports --
import { useTrackCover } from "../tracks/useTrackCover";
import { useTrackDisplay } from "./useTrackDisplay";

// -- State Imports --
import { useLoadPreferences } from "../../state/preferences/store";
import {
  useCurrentTrackId,
  usePlayerActions,
  usePlayerStatus,
  usePlayerSync,
} from "../../state/player/store";
import { useSpectrumSync } from "../../state/player/spectrum";

// -- IPC Imports --
import { hideNowPlayingWidget, setSetting } from "../../lib/ipc";
import { onWindowMoved } from "../../lib/appWindow";

// -- i18n Imports --
import { useT } from "../../i18n";

// -- Style Imports --
import styles from "./NowPlayingWidget.module.css";

/** How long a drag rests before its new position is persisted, so a move writes once, not per frame. */
const MOVE_DEBOUNCE = 400;

/**
 * The pop-out now-playing widget: a frameless always-on-top card floating over every app, run in its
 * own webview. It hydrates preferences, theme and the playback snapshot itself like the tray, then
 * shows the current track over a blurred-cover ground with a scrubbable playhead and the transport.
 * Nothing playing folds to an idle placeholder rather than yanking the window away. Its position is
 * remembered across sessions: the move listener writes the physical top-left, the Rust seat reads it.
 */
export function NowPlayingWidget() {
  const loadPreferences = useLoadPreferences();
  const trackId = useCurrentTrackId();

  useEffect(() => {
    void loadPreferences();
  }, [loadPreferences]);
  // The card always sits on the dark cover ground, so it forces the root dark rather than following the
  // user's light/dark pref: the dark tokens the controls read then resolve in any app theme.
  useEffect(() => {
    document.documentElement.dataset.theme = "dark";
  }, []);
  usePlayerSync();
  useSpectrumSync();
  usePersistPosition();

  return trackId == null ? <IdleCard /> : <WidgetBody trackId={trackId} />;
}

/** Persists the window's top-left after a drag settles, debounced so a move writes once. */
function usePersistPosition() {
  useEffect(() => {
    let unlisten = () => {};
    let alive = true;
    let timer: ReturnType<typeof setTimeout> | undefined;

    void onWindowMoved(({ x, y }) => {
      if (timer) clearTimeout(timer);
      timer = setTimeout(() => {
        void setSetting("nowplaying_pos", `${x},${y}`).catch(() => {});
      }, MOVE_DEBOUNCE);
    }).then((fn) => {
      // A late resolve after unmount tears down at once, so no listener leaks past the window.
      if (alive) unlisten = fn;
      else fn();
    });

    return () => {
      alive = false;
      if (timer) clearTimeout(timer);
      unlisten();
    };
  }, []);
}

/**
 * The card shell shared by the playing and idle states: the blurred-cover ground, the dark scrim for
 * legibility, the foreground content and the close button. `data-tauri-drag-region="deep"` makes the
 * whole card a grab surface; the interactive controls block the drag themselves, so they keep their
 * clicks. The card forces a light-on-dark palette (see the stylesheet) since it always sits on the
 * dark ground, so the token-driven controls read legibly.
 */
function CardShell({ coverSrc, children }: { coverSrc: string | null; children: ReactNode }) {
  const t = useT();

  return (
    <div className={styles.card} data-tauri-drag-region="">
      <CoverBackdrop src={coverSrc} className={styles.bg} />
      <div className={styles.scrim} />
      <SpectrumRidge />
      <div className={styles.content}>{children}</div>
      <span className={styles.close}>
        <IconButton aria-label={t((d) => d.player.closeWidget)} onClick={() => void hideNowPlayingWidget()}>
          <X size={15} strokeWidth={1.8} />
        </IconButton>
      </span>
    </div>
  );
}

/**
 * The playing state: cover, title and artist over the seek bar and the roomier transport. Reads the
 * cover and display fields by id, so it only mounts with a real track id - the id-typed hooks never
 * run with a null id. The seek bar drives off the live snapshot and commits on release.
 */
function WidgetBody({ trackId }: { trackId: number }) {
  const { cover } = useTrackCover(trackId);
  const { title, artist } = useTrackDisplay(trackId);
  const status = usePlayerStatus();
  const actions = usePlayerActions();
  const t = useT();

  return (
    <CardShell coverSrc={cover?.src ?? null}>
      <span className={styles.cover}>
        <Cover src={cover?.src ?? null} alt="" />
      </span>
      <div className={styles.main}>
        <div className={styles.text}>
          <span className={styles.title}>{title ?? t((d) => d.albums.untitled)}</span>
          <span className={styles.artist}>{artist ?? t((d) => d.albums.unknownArtist)}</span>
        </div>
        <SeekBar
          position={status.position_secs}
          duration={status.duration_secs}
          onSeek={actions.seek}
        />
        <div className={styles.controls}>
          <div className={styles.seq}>
            <IconToggle
              size="sm"
              pressed={status.repeat !== "off"}
              aria-label={t((d) => d.player.repeat)}
              onClick={() => actions.setRepeat(nextRepeat(status.repeat))}
            >
              {status.repeat === "one" ? (
                <Repeat1 size={16} strokeWidth={1.8} />
              ) : (
                <Repeat size={16} strokeWidth={1.8} />
              )}
            </IconToggle>
          </div>
          <Transport size="md" />
          <div className={styles.vol}>
            <Volume volume={status.volume} railHeight={60} />
          </div>
        </div>
      </div>
    </CardShell>
  );
}

/** The idle placeholder held when nothing is playing: a greyed shell so the window never vanishes. */
function IdleCard() {
  const t = useT();

  return (
    <CardShell coverSrc={null}>
      <span className={styles.cover}>
        <Cover src={null} alt="" />
      </span>
      <div className={styles.main}>
        <div className={styles.text}>
          <span className={styles.title}>{t((d) => d.player.nothingPlaying)}</span>
        </div>
        <div className={styles.inert}>
          <Transport size="lg" />
        </div>
      </div>
    </CardShell>
  );
}
