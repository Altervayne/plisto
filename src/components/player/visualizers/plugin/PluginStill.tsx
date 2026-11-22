// -- Framework Imports --
import { useMemo, useRef, useSyncExternalStore } from "react";
import type { CSSProperties } from "react";

// -- State Imports --
import { sceneLight } from "../../../../state/player/visualizerKind";
import { kindValues, kindValuesKey } from "../../../../state/player/pluginVis/kindSettings";
import { useStill } from "../../../../state/player/pluginVis/useStill";
import { usePlayerVisualizerSettings } from "../../../../state/preferences/store";

// -- Utils Imports --
import { isDarkTheme, subscribeTheme } from "../../../../theme";

// -- Local Imports --
import { readStageContext } from "./stageContext";
import type { PluginStageProps } from "./usePluginStageMount";

// -- Style Imports --
import styles from "./PluginStage.module.css";

/**
 * A plugin kind under reduced motion: its still on a canvas of Plisto's own, in the slot a live frame
 * would fill, with the same blend and dip. No frame stays mounted; one short-lived mount makes each still.
 * A kind that has no still leaves the slot empty; one whose mount fails fails the stage like a live frame.
 */
export function PluginStill({ mountKey, ...props }: PluginStageProps & { mountKey: string }) {
  const { descriptor, shown, surface } = props;
  const slotRef = useRef<HTMLDivElement>(null);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const settingsRaw = usePlayerVisualizerSettings();
  const values = useMemo(() => kindValues(descriptor, settingsRaw), [descriptor, settingsRaw]);
  const valuesKey = useMemo(() => kindValuesKey(values), [values]);
  const live = useRef({ props, values });
  live.current = { props, values };
  const phase = useStill({
    descriptor,
    surface,
    mountKey,
    slotRef,
    canvasRef,
    context: () =>
      readStageContext(slotRef.current, live.current.props, descriptor, live.current.values, true),
    inputs: [props.palette, props.pixels, valuesKey],
    onFail: () => live.current.props.onFail(),
  });
  const rootDark = useSyncExternalStore(subscribeTheme, isDarkTheme);
  const look = descriptor.look[sceneLight(descriptor.id, !rootDark) ? "light" : "dark"];
  return (
    <div
      ref={slotRef}
      className={shown && phase === "ready" ? styles.slot : styles.held}
      style={{ mixBlendMode: look.blend as CSSProperties["mixBlendMode"] }}
      inert
      aria-hidden
    >
      <canvas ref={canvasRef} className={styles.frame} />
    </div>
  );
}
