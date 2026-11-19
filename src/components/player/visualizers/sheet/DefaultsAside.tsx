// -- Framework Imports --
import type { ReactNode } from "react";

// -- Icon Imports --
import { Disc, Music, X } from "lucide-react";

// -- State Imports --
import { useVisualizerDefaults, useVisualizerDefaultsStatus } from "../../../../state/player/visualizerDefaults";
import {
  clearDefaultTier,
  defaultActions,
  defaultWaits,
  type DefaultAction,
} from "../../../../state/player/visualizerResolve";

// -- Hook Imports --
import type { VisualizerResolution } from "../useVisualizerResolution";

// -- Type Imports --
import type { VisualizerFallback } from "../visualizerTarget";

// -- Local Imports --
import { VISUALIZER_VIEWS } from "../visualizerViews";

// -- i18n Imports --
import { useT } from "../../../../i18n";

// -- Style Imports --
import styles from "./DefaultsAside.module.css";

/**
 * The sheet footer's defaults block: one line saying which rule applies, the fallback line when the stage
 * draws something else, and the pills that set or clear a default. A pill the playing track cannot use is
 * absent, and one with nothing to do is dimmed with `aria-disabled` and ignores its press.
 */
export function DefaultsAside({
  resolved,
  fallback,
}: {
  resolved: VisualizerResolution;
  fallback: VisualizerFallback | null;
}) {
  const t = useT();
  const status = useVisualizerDefaultsStatus();
  const { place, resolution } = resolved;
  const { skipped } = resolution;
  const actions = defaultActions(place, resolution, status);
  const { setAlbumDefault, setTrackDefault } = useVisualizerDefaults.getState();

  const ridge = t(VISUALIZER_VIEWS.ridge.label);
  let line: string | null = null;
  const skippedName = skipped ? t(VISUALIZER_VIEWS[skipped.kind].label) : "";
  if (resolution.source === "override") line = t((d) => d.player.visualizerFootOverride);
  else if (skipped?.tier === "track") line = t((d) => d.player.visualizerSkippedTrack, { name: skippedName });
  else if (skipped?.tier === "album") line = t((d) => d.player.visualizerSkippedAlbum, { name: skippedName });
  else if (defaultWaits(resolution) && resolution.defaultKind) {
    const track = resolution.defaultTier === "track";
    const tier = track ? t((d) => d.player.visualizerTagTrack) : t((d) => d.player.visualizerTagAlbum);
    const name = t(VISUALIZER_VIEWS[resolution.defaultKind].label);
    line = t((d) => d.player.visualizerDefaultWaiting, { tier, name });
  } else if (resolution.source === "album") line = t((d) => d.player.visualizerFootAlbum);
  else if (resolution.source === "track") line = t((d) => d.player.visualizerFootTrack);
  let fallbackLine: string | null = null;
  if (fallback === "cover") fallbackLine = t((d) => d.player.visualizerFallbackCover, { ridge });
  else if (fallback === "gl") fallbackLine = t((d) => d.player.visualizerFallbackGl, { ridge });

  // The pill names its tier when it removes a turned-off default, which the line above names too.
  let clearLabel = t((d) => d.player.visualizerClearDefault);
  if (skipped?.tier === "track") clearLabel = t((d) => d.player.visualizerClearTrackDefault);
  else if (skipped?.tier === "album") clearLabel = t((d) => d.player.visualizerClearAlbumDefault);

  const useAlbum = () => {
    if (place.kind === "album" || place.kind === "single") void setAlbumDefault(place.albumId, resolution.picked);
  };
  const useTrack = () => {
    if (place.kind === "album" || place.kind === "loose") void setTrackDefault(place.trackId, resolution.picked);
  };
  const clear = () => {
    const tier = clearDefaultTier(resolution);
    if (tier === "track" && (place.kind === "album" || place.kind === "loose")) void setTrackDefault(place.trackId, null);
    if (tier === "album" && (place.kind === "album" || place.kind === "single")) void setAlbumDefault(place.albumId, null);
  };

  const pill = (action: DefaultAction, label: string, icon: ReactNode, run: () => void, leavesFocus = false) =>
    action.visible ? (
      <button
        type="button"
        className={styles.pill}
        aria-disabled={action.disabled}
        onClick={(event) => {
          if (action.disabled) return;
          // The pill can unmount with the write: focus returns to the checked tile first.
          if (leavesFocus) {
            event.currentTarget
              .closest('[role="menu"]')
              ?.querySelector<HTMLElement>('[aria-checked="true"]')
              ?.focus({ preventScroll: true });
          }
          run();
        }}
      >
        {icon}
        {label}
      </button>
    ) : null;

  return (
    <>
      {line ? (
        <div className={styles.line} title={line}>
          {line}
        </div>
      ) : null}
      {fallbackLine ? (
        <div className={styles.line} title={fallbackLine}>
          {fallbackLine}
        </div>
      ) : null}
      <div className={styles.actions}>
        {pill(actions.useAlbum, t((d) => d.player.visualizerUseAlbum), <Disc size={14} strokeWidth={1.8} />, useAlbum)}
        {pill(actions.useTrack, t((d) => d.player.visualizerUseTrack), <Music size={14} strokeWidth={1.8} />, useTrack)}
        {pill(actions.clear, clearLabel, <X size={14} strokeWidth={1.8} />, clear, true)}
      </div>
    </>
  );
}
