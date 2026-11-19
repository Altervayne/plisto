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
import { Tooltip } from "../../common/Tooltip";
import { UpNextGlance } from "./UpNextGlance";
import { VisualizerSheet } from "../visualizers/sheet/VisualizerSheet";
import { Visualizer } from "../visualizers/Visualizer";
import { Volume } from "../Volume";

// -- Hook Imports --
import { ambientCycleTarget } from "./ambientCycle";
import { useAmbientIdle } from "./useAmbientIdle";
import { useAmbientKeys } from "./useAmbientKeys";
import { useFullscreen } from "./useFullscreen";
import { coverStatus } from "../../tracks/coverStatus";
import { useTrackCover } from "../../tracks/useTrackCover";
import { useVisualizerChoice } from "../visualizers/useVisualizerChoice";
import { useLoadingCue } from "../visualizers/useLoadingCue";
import { useVisualizerPick } from "../visualizers/useVisualizerPick";

// -- State Imports --
import { useVisualizerCatalog } from "../../../state/preferences/store";
import { usePlayerActions, usePlayerStatus, useSeatedStream } from "../../../state/player/store";
import { showsScrubber, waitingPhase } from "../../../state/player/streamView";
import { isDarkOnly, type VisualizerKind } from "../../../state/player/visualizerKind";
import { useVisualizerSheet, useVisualizerSheetOpen } from "../../../state/player/visualizerSheet";
import { useVisualizersAllowed } from "../../../state/player/visualizerWarning";

// -- Local Imports --
import { panelScheme, useSchemeSwap } from "../panelScheme";
import { PanelSchemeContext, schemeStamp } from "../../../theme/scheme";
import { VISUALIZER_VIEWS } from "../visualizers/visualizerViews";
import { useIsWarm } from "../visualizers/gl/warmState";
import { waitWord } from "../streamWords";

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
  const stream = useSeatedStream();
  const wait = stream ? waitingPhase(stream.state) : null;
  const { cover, coverFor, loading } = useTrackCover(trackId, false, stream?.art_rev ?? 0);
  const artStatus = coverStatus(trackId, coverFor, loading, cover != null);
  const coverSrc = cover?.src ?? null;
  // The stage carries the dip's opacity for the visualizer and the cover crossfade.
  const stageRef = useRef<HTMLDivElement | null>(null);
  const choice = useVisualizerChoice(coverSrc, artStatus, trackId, stageRef);
  const { shown, picked } = choice;
  const pick = useVisualizerPick(trackId);
  const catalog = useVisualizerCatalog();
  const status = usePlayerStatus();
  const actions = usePlayerActions();
  const sheetOpen = useVisualizerSheetOpen();
  const allowed = useVisualizersAllowed();
  const { faded, wake } = useAmbientIdle(sheetOpen);
  const t = useT();
  const coverRef = useRef<HTMLSpanElement | null>(null);
  // The seek bar the visualizer rests on, and the words it quiets itself behind.
  const seekRef = useRef<HTMLDivElement | null>(null);
  const textRef = useRef<HTMLDivElement | null>(null);
  const hushRefs = useMemo(() => [textRef], []);
  const [hint, setHint] = useState(true);
  const [toast, setToast] = useState<{
    label: string;
    name: string;
    kind: VisualizerKind;
    id: number;
    gone: boolean;
  } | null>(null);
  // The toast holds while its kind builds, then reads normally and fades.
  const toastWarm = useIsWarm(toast?.kind ?? "off");
  const toastLoading = useLoadingCue(toast && !toastWarm ? toast.kind : null);

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
    if (!toast || toast.gone || !toastWarm) return;
    const timer = window.setTimeout(() => setToast((was) => was && { ...was, gone: true }), TOAST_MS);
    return () => window.clearTimeout(timer);
  }, [toast, toastWarm]);

  const cycle = () => {
    const next = ambientCycleTarget(allowed, catalog, picked);
    if (next == null) return;
    // The suffix says the pick holds for this album only, which is true when it set a default aside.
    const setAside = pick(next).override != null;
    const name = t(VISUALIZER_VIEWS[next].label);
    const label = name + (setAside ? t((d) => d.player.visualizerToastSuffix) : "");
    setToast((was) => ({ label, name, kind: next, id: (was?.id ?? 0) + 1, gone: false }));
    wake();
  };

  useAmbientKeys({ stage: stageRef, onExit, onCycle: cycle, onTogglePlay: actions.toggle, onWake: wake });

  const fade = faded ? "" : undefined;
  // A dark-only kind makes the stage a dark island in either theme.
  const darkOnly = isDarkOnly(shown);
  const scheme = panelScheme(darkOnly);
  const swap = useSchemeSwap(darkOnly);
  // Liquid and Dot cover draw the art themselves, under a clear tile over the cover.
  let drawnTile: string | null = null;
  if (shown === "liquid") drawnTile = styles.liquidTile;
  else if (shown === "dot-cover") drawnTile = styles.dotTile;

  // Until the flash notice is acknowledged the button is inert; its tooltip points to the Player's notice.
  const waves = (
    <IconButton
      aria-label={t((d) => d.player.visualizer)}
      onClick={(e) => useVisualizerSheet.getState().toggle(e.currentTarget)}
      aria-disabled={allowed ? undefined : true}
      aria-haspopup="menu"
      aria-expanded={sheetOpen}
    >
      <Waves size={20} strokeWidth={1.8} />
    </IconButton>
  );
  const visualizerButton = allowed ? waves : <Tooltip label={t((d) => d.player.warnElsewhereTip)}>{waves}</Tooltip>;

  return createPortal(
    <PanelSchemeContext.Provider value={scheme}>
      <div
        ref={stageRef}
        className={swap ? `${styles.stage} ${swap}` : styles.stage}
        tabIndex={-1}
        role="region"
        aria-label={t((d) => d.player.ambientMode)}
        {...schemeStamp(scheme)}
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
            <span>
              {toastLoading
                ? t((d) => d.player.visualizerToastLoading, { name: toast.name })
                : t((d) => d.player.visualizerToast, { name: toast.label })}
            </span>
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
            <SeekBar
              position={status.position_secs}
              duration={status.duration_secs}
              onSeek={actions.seek}
              listenedOnly={stream != null && !showsScrubber(stream, status.duration_secs)}
              note={wait ? waitWord(t, wait) : null}
            />
          </div>
          <div className={styles.row}>
            <UpNextGlance active={status.track_id != null && stream == null} />
            <AmbientTransport />
            <div className={styles.right}>
              {visualizerButton}
              <Volume volume={status.volume} />
            </div>
          </div>
        </div>
      </div>
    </PanelSchemeContext.Provider>,
    document.body,
  );
}
