// -- Framework Imports --
import type { ReactNode } from "react";

// -- Component Imports --
import { SegmentedControl } from "../../../common/SegmentedControl";

// -- State Imports --
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
 * picked, so the sheet never grows when it appears. Both persist as prefs. `aside` sits at the trailing edge.
 */
export function SheetFooter({ picked, aside }: { picked: VisualizerKind; aside?: ReactNode }) {
  const reactivity = usePlayerVisualizerReactivity();
  const setReactivity = useSetPlayerVisualizerReactivity();
  const layout = usePlayerSpectrumLayout();
  const setLayout = useSetPlayerSpectrumLayout();
  const t = useT();
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
    <div className={styles.footer}>
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
      <div className={styles.grow} />
      {aside != null ? <div className={styles.aside}>{aside}</div> : null}
    </div>
  );
}
