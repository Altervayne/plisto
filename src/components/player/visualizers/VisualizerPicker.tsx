// -- Framework Imports --
import { useEffect, useRef, useState } from "react";

// -- Icon Imports --
import { Check, Waves } from "lucide-react";

// -- Component Imports --
import { IconToggle } from "../../common/IconToggle";
import { VisualizerGlyph } from "./VisualizerGlyph";

// -- State Imports --
import { usePlayerVisualizer, useSetPlayerVisualizer } from "../../../state/preferences/store";
import { VISUALIZER_KINDS } from "../../../state/player/visualizerKind";

// -- Local Imports --
import { visualizerLabel } from "./visualizerLabel";

// -- i18n Imports --
import { useT } from "../../../i18n";

// -- Style Imports --
// The picker is the sequence menu's sibling in the queue header and wears its exact popover.
import styles from "../SequenceMenu.module.css";

/**
 * The visualizer pick: a quiet button in the queue header opening a small popover with one radio row per
 * visualizer. The pick persists as a pref and reaches the Player and ambient mode alike. The chosen row
 * reads by a check and its ink, never the accent; the button lifts into a chip only while open.
 */
export function VisualizerPicker() {
  const picked = usePlayerVisualizer();
  const setPicked = useSetPlayerVisualizer();
  const t = useT();
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
        </div>
      ) : null}
    </div>
  );
}
