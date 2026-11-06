// -- Framework Imports --
import { useEffect, useRef } from "react";

// -- Type Imports --
import type { RefObject } from "react";

// -- Style Imports --
import styles from "./LegibilityScrim.module.css";

// How far above the seek bar the solid part of the wash reaches.
const GAP_PX = 8;
const AMBIENT_GAP_PX = 10;

/**
 * The wash that keeps the foot of a stage readable over a visualizer: the theme's ground, rising from the
 * bottom edge to just above the seek bar, then easing out. It sits above the visualizer and below the
 * controls. `active` shows it; in ambient mode `faded` takes it away with the chrome.
 */
export function LegibilityScrim({
  active,
  floorRef,
  ambient = false,
  faded = false,
}: {
  active: boolean;
  // The seek bar, which the solid part of the wash stops just above.
  floorRef: RefObject<HTMLElement | null>;
  ambient?: boolean;
  faded?: boolean;
}) {
  const scrimRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    const scrim = scrimRef.current;
    const stage = scrim?.parentElement;
    const floor = floorRef.current;
    if (!scrim || !stage || !floor) return;
    const gap = ambient ? AMBIENT_GAP_PX : GAP_PX;
    const measure = () => {
      const s = stage.getBoundingClientRect();
      const stageBottom = s.top + stage.clientTop + stage.clientHeight;
      const solid = Math.max(0, stageBottom - (floor.getBoundingClientRect().top - gap));
      scrim.style.setProperty("--scrim-solid", `${solid}px`);
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(stage);
    observer.observe(floor);
    return () => observer.disconnect();
  }, [floorRef, ambient]);

  return (
    <div
      ref={scrimRef}
      className={styles.scrim}
      data-active={active ? "" : undefined}
      data-ambient={ambient ? "" : undefined}
      data-faded={faded ? "" : undefined}
      aria-hidden="true"
    />
  );
}
