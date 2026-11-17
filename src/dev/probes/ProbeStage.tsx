/*
 * The stage replica: the player's panel, cover glow, aurora layer and visualizer slot, built from the
 * app's own classes so a blend over it behaves as in the player. The glow's breathing is off and the
 * aurora is a fixed field, so two stages capture identically. The slot sits in a probe-local wrapper that
 * is not a stacking context until a probe isolates it as the negative control of a blend.
 */

// -- Framework Imports --
import { forwardRef, useCallback, useEffect, useImperativeHandle, useLayoutEffect, useMemo, useRef } from "react";

// -- Local Imports --
import { clearChildren, gridShift, stackingBreaks } from "./stage";
import { AURORA_BLUR_PX, AURORA_OPACITY, coverFixtureUrl, paintAurora } from "./stageArt";

// -- Type Imports --
import type { StageHandle, Theme } from "./types";

// -- Style Imports --
import player from "../../components/player/PlayerView.module.css";
import aurora from "../../components/player/Aurora.module.css";
import viz from "../../components/player/visualizers/GlVisualizer.module.css";
import styles from "./ProbeStage.module.css";

interface ProbeStageProps {
  label: string;
  /** Stage size in CSS pixels, already on whole device pixels. */
  width: number;
  height: number;
  theme: Theme;
}

export const ProbeStage = forwardRef<StageHandle, ProbeStageProps>(function ProbeStage(
  { label, width, height, theme },
  ref,
) {
  const panelRef = useRef<HTMLDivElement>(null);
  const slotRef = useRef<HTMLDivElement>(null);
  const groupRef = useRef<HTMLDivElement>(null);
  const auroraRef = useRef<HTMLCanvasElement>(null);
  const figureRef = useRef<HTMLElement>(null);
  const cover = useMemo(coverFixtureUrl, []);

  // Measures the slot with no offset, then offsets the figure so the slot's top-left lies on a device pixel.
  const snapToGrid = useCallback(() => {
    const figure = figureRef.current;
    const slot = slotRef.current;
    if (!figure || !slot) return;
    figure.style.left = "0px";
    figure.style.top = "0px";
    const box = slot.getBoundingClientRect();
    const dpr = window.devicePixelRatio;
    figure.style.left = `${gridShift(box.left, dpr)}px`;
    figure.style.top = `${gridShift(box.top, dpr)}px`;
  }, []);

  useEffect(() => {
    if (auroraRef.current) paintAurora(auroraRef.current);
  }, []);

  // A resize also fires on a zoom or a move to another display, which is when the pixel ratio changes.
  useLayoutEffect(() => {
    snapToGrid();
    window.addEventListener("resize", snapToGrid);
    return () => window.removeEventListener("resize", snapToGrid);
  }, [snapToGrid, width, height]);

  useImperativeHandle(
    ref,
    () => ({
      get panel() {
        return panelRef.current as HTMLElement;
      },
      get slot() {
        return slotRef.current as HTMLElement;
      },
      setBlend(mode) {
        if (slotRef.current) slotRef.current.style.mixBlendMode = mode;
      },
      setDip(opacity) {
        slotRef.current?.style.setProperty("--viz-dip", String(opacity));
      },
      setIsolated(on) {
        if (groupRef.current) groupRef.current.style.isolation = on ? "isolate" : "";
      },
      snapToGrid,
      clearSlot() {
        if (slotRef.current) clearChildren(slotRef.current);
      },
      stackingBreaks() {
        return slotRef.current && panelRef.current ? stackingBreaks(slotRef.current, panelRef.current) : [];
      },
    }),
    [snapToGrid],
  );

  return (
    <figure ref={figureRef} className={styles.figure}>
      <div ref={panelRef} className={player.panel} style={{ width, height, margin: 0, flex: "none" }}>
        <div className={player.glow} style={{ backgroundImage: `url(${cover})`, animation: "none" }} />
        <canvas
          ref={auroraRef}
          className={aurora.aurora}
          style={{
            filter: `blur(${AURORA_BLUR_PX}px)`,
            mixBlendMode: theme === "dark" ? "screen" : "normal",
            opacity: AURORA_OPACITY[theme],
          }}
        />
        <div ref={groupRef} className={styles.group}>
          <div ref={slotRef} className={viz.slot} />
        </div>
      </div>
      <figcaption className={styles.caption}>{label}</figcaption>
    </figure>
  );
});
