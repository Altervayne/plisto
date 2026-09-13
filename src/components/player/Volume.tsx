// -- Framework Imports --
import { useRef, useState } from "react";
import type { CSSProperties, DragEvent, KeyboardEvent, PointerEvent } from "react";

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
 * The speaker with a reveal-on-hover vertical level rail in a recessed chip floating above it, so the
 * control stays one quiet glyph until reached for. The rail borrows the seek bar's track/handle
 * vocabulary but its fill is neutral ink, never accent. The speaker glyph tracks the level so the state
 * reads while the chip is folded. Wired straight to the engine: dragging sets the level live, the pointer
 * mapped inverted so up is louder. `railHeight` shortens the rail where the default travel would clip.
 */
export function Volume({ volume, railHeight }: { volume: number; railHeight?: number }) {
  const actions = usePlayerActions();
  const t = useT();
  const railRef = useRef<HTMLDivElement>(null);
  // A live drag keeps the rail interactive even after the pointer strays above it, so the reveal gate
  // below cannot flip it pointer-events:none mid-drag and drop the capture onto the cover behind.
  const [dragging, setDragging] = useState(false);

  const level = clamp01(volume);
  const pct = level * 100;
  const Glyph = level === 0 ? VolumeX : level < 0.5 ? Volume1 : Volume2;

  // The level under the pointer, measured from the rail's floor up, so dragging toward the top raises it.
  const levelFromPointer = (e: PointerEvent<HTMLDivElement>): number => {
    const rail = railRef.current;
    if (!rail) return level;
    const rect = rail.getBoundingClientRect();
    return clamp01((rect.bottom - e.clientY) / rect.height);
  };

  const onPointerDown = (e: PointerEvent<HTMLDivElement>) => {
    setDragging(true);
    actions.setVolume(levelFromPointer(e));
    railRef.current?.setPointerCapture(e.pointerId);
  };

  const onPointerMove = (e: PointerEvent<HTMLDivElement>) => {
    if (!dragging) return;
    actions.setVolume(levelFromPointer(e));
  };

  const onPointerUp = (e: PointerEvent<HTMLDivElement>) => {
    setDragging(false);
    railRef.current?.releasePointerCapture(e.pointerId);
    // A pointer press focuses the rail, and focus-within would hold the chip open until a click elsewhere
    // blurred it. Dropping focus here lets it fold as soon as the pointer leaves; keyboard focus, which
    // never fires pointer up, keeps its own reveal.
    railRef.current?.blur();
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
    <div
      className={styles.volume}
      style={
        {
          "--level": level,
          ...(railHeight != null ? { "--rail-h": `${railHeight}px` } : {}),
        } as CSSProperties
      }
    >
      <div className={styles.chip}>
        <div
          ref={railRef}
          className={styles.rail}
          role="slider"
          tabIndex={0}
          aria-label={t((d) => d.player.volume)}
          aria-orientation="vertical"
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={Math.round(pct)}
          data-dragging={dragging ? "" : undefined}
          onPointerDown={onPointerDown}
          onPointerMove={onPointerMove}
          onPointerUp={onPointerUp}
          onKeyDown={onKeyDown}
          // A press-drag on the rail is never a native image/text drag; killing dragstart keeps the
          // no-drop cursor off the cover behind.
          onDragStart={(e: DragEvent) => e.preventDefault()}
        >
          <div className={styles.track}>
            <div className={styles.fill} />
          </div>
          <div className={styles.handle} aria-hidden="true" />
        </div>
      </div>
      <span className={styles.glyph} aria-hidden="true">
        <Glyph size={17} strokeWidth={1.8} />
      </span>
    </div>
  );
}
