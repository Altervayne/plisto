// -- Framework Imports --
import { useSyncExternalStore } from "react";
import type { CSSProperties } from "react";

// -- Hook Imports --
import { usePluginStageMount, type PluginStageProps } from "./usePluginStageMount";

// -- Component Imports --
import { PluginStill } from "./PluginStill";
import { StageReadout } from "./StageReadout";

// -- State Imports --
import { useFrameHealthStore } from "../../../../state/plugins/frameHealth";
import { sceneLight } from "../../../../state/player/visualizerKind";
import { useReducedMotion } from "../../../../state/player/pluginVis/useStill";

// -- Utils Imports --
import { isDarkTheme, subscribeTheme } from "../../../../theme";

// -- i18n Imports --
import { useT } from "../../../../i18n";

// -- Style Imports --
import styles from "./PluginStage.module.css";

/**
 * One plugin visualizer frame on a stage, keyed on its mount key so a frame is never reused across a
 * version, a manifest change or a plugin restart. The key's `vis|` namespace keeps it apart from page frames.
 * Under reduced motion no frame stays mounted: the kind shows its still instead.
 */
export function PluginStage(props: PluginStageProps) {
  const { descriptor, surface } = props;
  const reduced = useReducedMotion();
  const generation = useFrameHealthStore((s) => s.generation[descriptor.pluginId] ?? 0);
  const { id, version, manifestHash } = descriptor;
  const mountKey = `vis|${surface}|${id}|${version}|${manifestHash}|${generation}`;
  if (reduced) return <PluginStill key={mountKey} mountKey={mountKey} {...props} />;
  return <StageSlot key={mountKey} mountKey={mountKey} {...props} />;
}

/**
 * The slot and its sandboxed frame. The slot shows at the dip's opacity once this kind is shown and its
 * frame has drawn; before that it sits under the dip at opacity 0. Purely ambient: inert and aria-hidden,
 * with no overlay or crash card, whatever the frame does.
 */
function StageSlot({ mountKey, ...props }: PluginStageProps & { mountKey: string }) {
  const t = useT();
  const { descriptor, shown } = props;
  const { slotRef, iframeRef, src, phase, onLoad } = usePluginStageMount(props, mountKey);
  const rootDark = useSyncExternalStore(subscribeTheme, isDarkTheme);
  const look = descriptor.look[sceneLight(descriptor.id, !rootDark) ? "light" : "dark"];
  const live = shown && phase === "ready";
  return (
    <>
      <div
        ref={slotRef}
        className={live ? styles.slot : styles.held}
        style={{ mixBlendMode: look.blend as CSSProperties["mixBlendMode"] }}
        inert
        aria-hidden
      >
        {src != null ? (
          <iframe
            ref={iframeRef}
            className={styles.frame}
            title={t((d) => d.plugins.frame.title, { name: descriptor.name })}
            src={src}
            sandbox="allow-scripts"
            allow=""
            referrerPolicy="strict-origin"
            onLoad={onLoad}
          />
        ) : null}
      </div>
      <StageReadout kind={descriptor.id} surface={props.surface} shown={live} />
    </>
  );
}
