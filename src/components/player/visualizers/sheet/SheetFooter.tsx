// -- Framework Imports --
import type { ReactNode } from "react";

// -- Icon Imports --
import { SlidersHorizontal } from "lucide-react";

// -- Component Imports --
import { SegmentedControl } from "../../../common/SegmentedControl";

// -- Local Imports --
import { PluginKindControls } from "./PluginKindControls";

// -- State Imports --
import { isPluginKindId, pluginVisualizer } from "../../../../state/player/pluginVisualizers";
import {
  usePlayerSpectrumLayout,
  usePlayerVisualizerReactivity,
  useSetPlayerSpectrumLayout,
  useSetPlayerVisualizerReactivity,
} from "../../../../state/preferences/store";
import {
  REACTIVITY_LEVELS,
  SPECTRUM_LAYOUTS,
  type Reactivity,
  type SpectrumLayout,
  type VisualizerKind,
} from "../../../../state/player/visualizerKind";

// -- Type Imports --
import type { Segment } from "../../../common/SegmentedControl";

// -- i18n Imports --
import { useT } from "../../../../i18n";

// -- Style Imports --
// The rows wear the EQ preset row's compact stretch.
import rowStyles from "../../../sound/PresetRow.module.css";
import styles from "./SheetFooter.module.css";

/**
 * The sheet's footer: the reactivity row, and the dot spectrum's layout row beside it while that kind is
 * picked, so the sheet never grows when it appears. Both persist as prefs. A picked plugin kind with settings
 * adds its own controls and presets there, wrapping onto more rows when they need the room. `onManage` adds
 * a quiet link after them in the same row; `aside` sits at the trailing edge.
 */
export function SheetFooter({
  picked,
  aside,
  onManage,
}: {
  picked: VisualizerKind;
  aside?: ReactNode;
  onManage?: () => void;
}) {
  const reactivity = usePlayerVisualizerReactivity();
  const setReactivity = useSetPlayerVisualizerReactivity();
  const layout = usePlayerSpectrumLayout();
  const setLayout = useSetPlayerSpectrumLayout();
  const t = useT();
  const plugin = isPluginKindId(picked) ? pluginVisualizer(picked) : undefined;
  const kindSettings = plugin && plugin.settings.length > 0 ? plugin : undefined;
  const reactivityLabels: Record<Reactivity, string> = {
    calm: t((d) => d.player.reactivityCalm),
    balanced: t((d) => d.player.reactivityBalanced),
    lively: t((d) => d.player.reactivityLively),
  };
  const reactivitySegments: Segment<Reactivity>[] = REACTIVITY_LEVELS.map((value) => ({
    value,
    label: reactivityLabels[value],
  }));
  const layoutLabels: Record<SpectrumLayout, string> = {
    "bass-left": t((d) => d.player.spectrumBassLeft),
    mirrored: t((d) => d.player.spectrumMirrored),
  };
  const layoutSegments: Segment<SpectrumLayout>[] = SPECTRUM_LAYOUTS.map((value) => ({
    value,
    label: layoutLabels[value],
  }));

  return (
    <div className={kindSettings ? `${styles.footer} ${styles.wrap}` : styles.footer}>
      <div className={styles.group}>
        <span className={styles.label}>{t((d) => d.player.visualizerReactivity)}</span>
        <div className={rowStyles.compact}>
          <SegmentedControl
            segments={reactivitySegments}
            value={reactivity}
            onChange={setReactivity}
            label={t((d) => d.player.visualizerReactivity)}
          />
        </div>
      </div>
      {picked === "dot-spectrum" ? (
        <div className={`${styles.group} ${styles.layout}`}>
          <span className={styles.label}>{t((d) => d.player.spectrumLayout)}</span>
          <div className={rowStyles.compact}>
            <SegmentedControl
              segments={layoutSegments}
              value={layout}
              onChange={setLayout}
              label={t((d) => d.player.spectrumLayout)}
            />
          </div>
        </div>
      ) : null}
      {/* Keyed by kind, so a pending write never moves to the next kind picked. */}
      {kindSettings ? <PluginKindControls key={kindSettings.id} descriptor={kindSettings} /> : null}
      {onManage ? (
        <button type="button" className={styles.manage} onClick={onManage}>
          <SlidersHorizontal size={15} aria-hidden="true" />
          {t((d) => d.player.manageVisualizers)}
        </button>
      ) : null}
      <div className={styles.grow} />
      {aside != null ? <div className={styles.aside}>{aside}</div> : null}
    </div>
  );
}
