// -- Framework Imports --
import { useEffect, useRef, useState } from "react";

// -- Icon Imports --
import { Check, Waves } from "lucide-react";

// -- Component Imports --
import { IconToggle } from "../../common/IconToggle";
import { SegmentedControl } from "../../common/SegmentedControl";
import { VisualizerGlyph } from "./VisualizerGlyph";

// -- State Imports --
import {
  usePlayerSpectrumLayout,
  usePlayerVisualizer,
  usePlayerVisualizerReactivity,
  useSetPlayerSpectrumLayout,
  useSetPlayerVisualizer,
  useSetPlayerVisualizerReactivity,
} from "../../../state/preferences/store";
import {
  REACTIVITY_LEVELS,
  SPECTRUM_LAYOUTS,
  VISUALIZER_KINDS,
  type Reactivity,
  type SpectrumLayout,
} from "../../../state/player/visualizerKind";

// -- Type Imports --
import type { Segment } from "../../common/SegmentedControl";

// -- Local Imports --
import { visualizerLabel } from "./visualizerLabel";

// -- i18n Imports --
import { useT } from "../../../i18n";

// -- Style Imports --
// The picker is the sequence menu's sibling in the queue header and wears its exact popover; the
// reactivity row wears the EQ preset row's compact stretch.
import styles from "../SequenceMenu.module.css";
import rowStyles from "../../sound/PresetRow.module.css";

/**
 * The visualizer pick: a quiet button in the queue header opening a small popover with one radio row per
 * visualizer, then a segmented reactivity row, and a layout row while the dot spectrum is picked. All
 * persist as prefs and reach the Player and ambient mode alike. The chosen row reads by a check and its
 * ink, never the accent; the button lifts into a chip only while open.
 */
export function VisualizerPicker() {
  const picked = usePlayerVisualizer();
  const setPicked = useSetPlayerVisualizer();
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
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const checkedRef = useRef<HTMLButtonElement | null>(null);
  const [open, setOpen] = useState(false);

  // While open, an outside press dismisses it, mirroring the sequence menu beside it.
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!wrapRef.current?.contains(event.target as Node)) setOpen(false);
    };
    window.addEventListener("pointerdown", onPointerDown, true);
    return () => window.removeEventListener("pointerdown", onPointerDown, true);
  }, [open]);

  // On open, move focus to the chosen row once it has painted.
  useEffect(() => {
    if (!open) return;
    const frame = requestAnimationFrame(() => checkedRef.current?.focus({ preventScroll: true }));
    return () => cancelAnimationFrame(frame);
  }, [open]);

  return (
    <div
      ref={wrapRef}
      className={styles.wrap}
      onKeyDown={(event) => {
        if (event.key === "Escape" && open) {
          event.stopPropagation();
          setOpen(false);
        }
      }}
    >
      <IconToggle
        pressed={open}
        aria-label={t((d) => d.player.visualizer)}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((was) => !was)}
      >
        <Waves size={18} strokeWidth={1.8} />
      </IconToggle>

      {open ? (
        <div className={styles.pop} role="menu" aria-label={t((d) => d.player.visualizer)}>
          <div className={styles.group} role="radiogroup" aria-label={t((d) => d.player.visualizer)}>
            <span className={styles.groupLabel}>{t((d) => d.player.visualizer)}</span>
            {VISUALIZER_KINDS.map((kind) => {
              const selected = kind === picked;
              return (
                <button
                  key={kind}
                  type="button"
                  role="radio"
                  aria-checked={selected}
                  ref={selected ? checkedRef : undefined}
                  className={styles.item}
                  onClick={() => setPicked(kind)}
                >
                  <span className={styles.icon} aria-hidden="true">
                    <VisualizerGlyph kind={kind} />
                  </span>
                  <span className={styles.label}>{t(visualizerLabel(kind))}</span>
                  <span className={styles.check} aria-hidden="true">
                    {selected ? <Check size={15} strokeWidth={2} /> : null}
                  </span>
                </button>
              );
            })}
          </div>
          <div className={styles.sep} />
          <div className={styles.group}>
            <span className={styles.groupLabel}>{t((d) => d.player.visualizerReactivity)}</span>
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
            <>
              <div className={styles.sep} />
              <div className={styles.group}>
                <span className={styles.groupLabel}>{t((d) => d.player.spectrumLayout)}</span>
                <div className={rowStyles.compact}>
                  <SegmentedControl
                    segments={layoutSegments}
                    value={layout}
                    onChange={setLayout}
                    label={t((d) => d.player.spectrumLayout)}
                  />
                </div>
              </div>
            </>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
