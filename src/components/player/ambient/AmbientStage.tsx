// -- Framework Imports --
import { useEffect, useMemo, useRef, useState } from "react";
import { createPortal } from "react-dom";

// -- Icon Imports --
import { Minimize2, Music, Waves } from "lucide-react";

// -- Component Imports --
import { Aurora } from "../Aurora";
import { AmbientText } from "./AmbientText";
import { AmbientTransport } from "./AmbientTransport";
import { Cover } from "../../common/Cover/Cover";
import { IconButton } from "../../common/IconButton";
import { LegibilityScrim } from "../LegibilityScrim";
import { SeekBar } from "../SeekBar";
import { UpNextGlance } from "./UpNextGlance";
import { VisualizerSheet } from "../visualizers/sheet/VisualizerSheet";
import { Visualizer } from "../visualizers/Visualizer";
import { Volume } from "../Volume";

// -- Hook Imports --
import { useAmbientIdle } from "./useAmbientIdle";
import { useAmbientKeys } from "./useAmbientKeys";
import { useFullscreen } from "./useFullscreen";
import { coverStatus } from "../../tracks/coverStatus";
import { useTrackCover } from "../../tracks/useTrackCover";
import { useVisualizerChoice } from "../visualizers/useVisualizerChoice";
import { useVisualizerPick } from "../visualizers/useVisualizerPick";

// -- State Imports --
import { usePlayerActions, usePlayerStatus } from "../../../state/player/store";
import { nextVisualizerKind } from "../../../state/player/visualizerKind";
import { useVisualizerSheet, useVisualizerSheetOpen } from "../../../state/player/visualizerSheet";

// -- Local Imports --
import { VISUALIZER_VIEWS } from "../visualizers/visualizerViews";

// -- i18n Imports --
import { useT } from "../../../i18n";

// -- Style Imports --
import styles from "./AmbientStage.module.css";

// How long the exit hint shows on entry, and the visualizer name after a cycle.
const HINT_MS = 3000;
const TOAST_MS = 1500;

/**
 * Ambient mode: the now-playing track over the whole screen in OS full-screen, cover left and title
 * right, with the aurora and the picked visualizer filling the stage. The chrome (seek, transport,
 * volume, up next) and the exit control fade after a few idle seconds; the title and artist stay. Escape
 * or the exit control leaves, restoring the window; V cycles the visualizer and the waves button opens the
 * picker sheet, which floats above the chrome, lifts the cover and words, and keeps the chrome awake.
 *
 * `trackId` is the track on show, which outlives the queue: when the last track ends the stage stays on
 * it in its paused look. The app beneath goes inert while the stage is up, so focus never wanders under it.
 */
export function AmbientStage({ trackId, onExit }: { trackId: number; onExit: () => void }) {
  const { cover, coverFor, loading } = useTrackCover(trackId);
  const artStatus = coverStatus(trackId, coverFor, loading, cover != null);
  const coverSrc = cover?.src ?? null;
  // The stage carries the dip's opacity for the visualizer and the cover crossfade.
  const stageRef = useRef<HTMLDivElement | null>(null);
  const choice = useVisualizerChoice(coverSrc, artStatus, trackId, stageRef);
  const { shown, picked } = choice;
  const pick = useVisualizerPick(trackId);
  const status = usePlayerStatus();
  const actions = usePlayerActions();
  const sheetOpen = useVisualizerSheetOpen();
  const { faded, wake } = useAmbientIdle(sheetOpen);
  const t = useT();
  const coverRef = useRef<HTMLSpanElement | null>(null);
  // The seek bar the visualizer rests on, and the words it quiets itself behind.
  const seekRef = useRef<HTMLDivElement | null>(null);
  const textRef = useRef<HTMLDivElement | null>(null);
  const hushRefs = useMemo(() => [textRef], []);
  const [hint, setHint] = useState(true);
  const [toast, setToast] = useState<{ label: string; id: number; gone: boolean } | null>(null);

  useFullscreen();

  // Hold focus on the stage and keep it out of the app underneath.
  useEffect(() => {
    const root = document.getElementById("root");
    if (root) root.inert = true;
    stageRef.current?.focus({ preventScroll: true });
    return () => {
      if (root) root.inert = false;
    };
  }, []);

  useEffect(() => {
    const timer = window.setTimeout(() => setHint(false), HINT_MS);
    return () => window.clearTimeout(timer);
  }, []);

  // The name shows, then fades where it sits; a new cycle remounts it by id.
  useEffect(() => {
    if (!toast || toast.gone) return;
    const timer = window.setTimeout(() => setToast((was) => was && { ...was, gone: true }), TOAST_MS);
    return () => window.clearTimeout(timer);
  }, [toast]);

  const cycle = () => {
    const next = nextVisualizerKind(picked);
    // The suffix says the pick holds for this album only, which is true when it set a default aside.
    const setAside = pick(next).override != null;
    const label = t(VISUALIZER_VIEWS[next].label) + (setAside ? t((d) => d.player.visualizerToastSuffix) : "");
    setToast((was) => ({ label, id: (was?.id ?? 0) + 1, gone: false }));
    wake();
  };

  useAmbientKeys({ stage: stageRef, onExit, onCycle: cycle, onTogglePlay: actions.toggle, onWake: wake });

  const fade = faded ? "" : undefined;
  // Liquid and Dot cover draw the art themselves, under a clear tile over the cover.
  let drawnTile: string | null = null;
  if (shown === "liquid") drawnTile = styles.liquidTile;
  else if (shown === "dot-cover") drawnTile = styles.dotTile;

  return createPortal(
    <div
      ref={stageRef}
      className={styles.stage}
      tabIndex={-1}
      role="region"
      aria-label={t((d) => d.player.ambientMode)}
      data-faded={fade}
      data-legible={shown !== "off" ? "" : undefined}
      onPointerMove={wake}
      onPointerDown={wake}
    >
      <Aurora trackId={trackId} coverRef={coverRef} coverless={artStatus === "coverless"} eased />
      <Visualizer
        choice={choice}
        trackId={trackId}
        ambient
        coverRef={coverRef}
        floorRef={seekRef}
        hushRefs={hushRefs}
      />
      <LegibilityScrim active={shown !== "off"} floorRef={seekRef} ambient faded={faded} />

      <div className={styles.body} data-lifted={sheetOpen ? "" : undefined}>
        <span ref={coverRef} className={styles.cover}>
          <span className={styles.coverArt} data-drawn={drawnTile ? "" : undefined}>
            {coverSrc ? (
              <Cover src={coverSrc} alt="" />
            ) : (
              <span className={styles.noCover} aria-hidden="true">
                <Music size={72} strokeWidth={1.2} />
              </span>
            )}
          </span>
          {drawnTile ? <span className={drawnTile} aria-hidden="true" /> : null}
        </span>
        <AmbientText trackId={trackId} faded={faded} textRef={textRef} />
      </div>

      <div className={styles.pill} data-place="hint" data-gone={hint ? undefined : ""} aria-hidden={!hint}>
        <kbd className={styles.kbd}>{t((d) => d.shortcuts.keys.esc)}</kbd>
        {t((d) => d.player.ambientExitHint)}
      </div>
      {toast ? (
        <div
          key={toast.id}
          className={styles.pill}
          data-place="toast"
          data-gone={toast.gone ? "" : undefined}
          role="status"
        >
          <Waves size={15} strokeWidth={1.8} aria-hidden="true" />
          <span>{t((d) => d.player.visualizerToast, { name: toast.label })}</span>
        </div>
      ) : null}

      <div className={styles.exit} data-faded={fade}>
        <kbd className={styles.kbd}>{t((d) => d.shortcuts.keys.esc)}</kbd>
        <IconButton aria-label={t((d) => d.player.exitAmbient)} onClick={onExit}>
          <Minimize2 size={20} strokeWidth={1.8} />
        </IconButton>
      </div>

      <VisualizerSheet place="ambient" trackId={trackId} fallback={choice.fallback} />

      <div className={styles.chrome} data-faded={fade}>
        <div ref={seekRef} className={styles.seek}>
          <SeekBar position={status.position_secs} duration={status.duration_secs} onSeek={actions.seek} />
        </div>
        <div className={styles.row}>
          <UpNextGlance active={status.track_id != null} />
          <AmbientTransport />
          <div className={styles.right}>
            <IconButton
              aria-label={t((d) => d.player.visualizer)}
              onClick={(e) => useVisualizerSheet.getState().toggle(e.currentTarget)}
              aria-haspopup="menu"
              aria-expanded={sheetOpen}
            >
              <Waves size={20} strokeWidth={1.8} />
            </IconButton>
            <Volume volume={status.volume} />
          </div>
        </div>
      </div>
    </div>,
    document.body,
  );
}
