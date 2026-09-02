// -- Framework Imports --
import { useRef } from "react";
import type { CSSProperties, KeyboardEvent, PointerEvent } from "react";

// -- Icon Imports --
import { Volume1, Volume2, VolumeX } from "lucide-react";

// -- State Imports --
import { usePlayerActions } from "../../state/player/store";

// -- i18n Imports --
import { useT } from "../../i18n";

// -- Style Imports --
import styles from "./Volume.module.css";

/** How far the arrow keys nudge the level, as a fraction of full. */
const KEY_STEP = 0.05;

/** Clamps a level into 0..1. */
function clamp01(v: number): number {
  return Math.min(1, Math.max(0, v));
}

/**
 * The speaker with a reveal-on-hover level rail. The rail borrows the seek bar's track and handle
 * vocabulary, but its fill is neutral ink, never accent - the seek fill is the one lit rail, and a
 * second accent here would read as a competing mark. The speaker glyph tracks the level so the state
 * reads even while the rail is folded away. Wired straight to the engine: dragging sets the level live.
 */
export function Volume({ volume }: { volume: number }) {
  const actions = usePlayerActions();
  const t = useT();
  const railRef = useRef<HTMLDivElement>(null);

  const level = clamp01(volume);
  const pct = level * 100;
  const Glyph = level === 0 ? VolumeX : level < 0.5 ? Volume1 : Volume2;

  // The level under the pointer, from its x within the rail.
  const levelFromPointer = (e: PointerEvent<HTMLDivElement>): number => {
    const rail = railRef.current;
    if (!rail) return level;
    const rect = rail.getBoundingClientRect();
    return clamp01((e.clientX - rect.left) / rect.width);
  };

  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    actions.setVolume(levelFromPointer(e));
    railRef.current?.setPointerCapture(e.pointerId);
  };

  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    if (!railRef.current?.hasPointerCapture(e.pointerId)) return;
    actions.setVolume(levelFromPointer(e));
  };

  const onPointerUp = (e: PointerEvent<HTMLDivElement>) => {
    railRef.current?.releasePointerCapture(e.pointerId);
  };

  const onKeyDown = (e: KeyboardEvent<HTMLDivElement>) => {
    switch (e.key) {
      case "ArrowLeft":
      case "ArrowDown":
        e.preventDefault();
        actions.setVolume(clamp01(level - KEY_STEP));
        break;
      case "ArrowRight":
      case "ArrowUp":
        e.preventDefault();
        actions.setVolume(clamp01(level + KEY_STEP));
        break;
      case "Home":
        e.preventDefault();
        actions.setVolume(0);
        break;
      case "End":
        e.preventDefault();
        actions.setVolume(1);
        break;
      default:
        break;
    }
  };

  return (
    <div className={styles.volume}>
      <span className={styles.glyph} aria-hidden="true">
        <Glyph size={19} strokeWidth={1.8} />
      </span>
      <div
        ref={railRef}
        className={styles.rail}
        style={{ "--pct": `${pct}%` } as CSSProperties}
        role="slider"
        tabIndex={0}
        aria-label={t((d) => d.player.volume)}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={Math.round(pct)}
        onPointerDown={onPointerDown}
        onPointerMove={onPointerMove}
        onPointerUp={onPointerUp}
        onKeyDown={onKeyDown}
      >
        <div className={styles.track}>
          <div className={styles.fill} />
        </div>
        <div className={styles.handle} aria-hidden="true" />
      </div>
    </div>
  );
}
