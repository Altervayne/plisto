// -- Framework Imports --
import { useEffect, useRef, useState } from "react";
import type { ReactNode } from "react";

// -- Icon Imports --
import { ArrowRight, Check, Repeat, Repeat1, Shuffle } from "lucide-react";

// -- Component Imports --
import { IconToggle } from "../common/IconToggle";

// -- State Imports --
import { usePlayerActions, usePlayerStatus } from "../../state/player/store";

// -- Type Imports --
import type { RepeatMode } from "../../types";

// -- Local Imports --
import { sequenceActive, sequenceGlyph } from "./sequenceState";

// -- i18n Imports --
import { useT } from "../../i18n";

// -- Style Imports --
import styles from "./SequenceMenu.module.css";

/**
 * The queue's sequencing control: one button opening a small anchored popover that carries the repeat
 * radio and an independent randomize toggle. Repeat and shuffle stay orthogonal - the popover just
 * repackages them - so it reads and writes the engine through the existing status and actions. The button
 * glyph mirrors the pair at a glance and lifts into a chip when a non-default mode is on. Neutral
 * throughout: the chosen rows read by a check and their ink, never the accent.
 */
export function SequenceMenu() {
  const status = usePlayerStatus();
  const actions = usePlayerActions();
  const t = useT();
  const wrapRef = useRef<HTMLDivElement | null>(null);
  const firstRef = useRef<HTMLButtonElement | null>(null);
  const [open, setOpen] = useState(false);

  // While open, an outside press dismisses it, mirroring the app's other floating panels. Escape is
  // handled on the wrapper below so it can be kept from reaching an ancestor's own Escape handler.
  useEffect(() => {
    if (!open) return;
    const onPointerDown = (event: PointerEvent) => {
      if (!wrapRef.current?.contains(event.target as Node)) setOpen(false);
    };
    window.addEventListener("pointerdown", onPointerDown, true);
    return () => window.removeEventListener("pointerdown", onPointerDown, true);
  }, [open]);

  // On open, move focus to the first row once it has painted.
  useEffect(() => {
    if (!open) return;
    const frame = requestAnimationFrame(() => firstRef.current?.focus({ preventScroll: true }));
    return () => cancelAnimationFrame(frame);
  }, [open]);

  const glyph = sequenceGlyph(status.repeat, status.shuffle);

  const repeatOptions: { value: RepeatMode; icon: ReactNode; label: string }[] = [
    { value: "off", icon: <ArrowRight size={15} strokeWidth={1.8} />, label: t((d) => d.player.playOnce) },
    { value: "all", icon: <Repeat size={15} strokeWidth={1.8} />, label: t((d) => d.player.repeatQueue) },
    { value: "one", icon: <Repeat1 size={15} strokeWidth={1.8} />, label: t((d) => d.player.repeatCurrent) },
  ];

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
        pressed={sequenceActive(status.repeat, status.shuffle)}
        aria-label={t((d) => d.player.sequencing)}
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => setOpen((was) => !was)}
      >
        {glyph === "shuffle" ? (
          <Shuffle size={18} strokeWidth={1.8} />
        ) : glyph === "repeat-one" ? (
          <Repeat1 size={18} strokeWidth={1.8} />
        ) : (
          <Repeat size={18} strokeWidth={1.8} />
        )}
      </IconToggle>

      {open ? (
        <div className={styles.pop} role="menu" aria-label={t((d) => d.player.sequencing)}>
          <div className={styles.group} role="radiogroup" aria-label={t((d) => d.player.repeat)}>
            <span className={styles.groupLabel}>{t((d) => d.player.repeat)}</span>
            {repeatOptions.map((option, i) => {
              const selected = status.repeat === option.value;
              return (
                <button
                  key={option.value}
                  type="button"
                  role="radio"
                  aria-checked={selected}
                  ref={i === 0 ? firstRef : undefined}
                  className={styles.item}
                  onClick={() => actions.setRepeat(option.value)}
                >
                  <span className={styles.icon} aria-hidden="true">
                    {option.icon}
                  </span>
                  <span className={styles.label}>{option.label}</span>
                  <span className={styles.check} aria-hidden="true">
                    {selected ? <Check size={15} strokeWidth={2} /> : null}
                  </span>
                </button>
              );
            })}
          </div>

          <div className={styles.sep} role="separator" />

          <button
            type="button"
            role="menuitemcheckbox"
            aria-checked={status.shuffle}
            className={styles.item}
            onClick={() => actions.setShuffle(!status.shuffle)}
          >
            <span className={styles.icon} aria-hidden="true">
              <Shuffle size={15} strokeWidth={1.8} />
            </span>
            <span className={styles.label}>{t((d) => d.player.randomize)}</span>
            <span className={styles.check} aria-hidden="true">
              {status.shuffle ? <Check size={15} strokeWidth={2} /> : null}
            </span>
          </button>
        </div>
      ) : null}
    </div>
  );
}
