// -- Framework Imports --
import { useEffect, useRef } from "react";
import type { RefObject } from "react";

// -- Local Imports --
import { blendModeFor, createRenderer, type Layout, type Renderer } from "./gl/renderer";
import type { Frame, Rect } from "./gl/kit";

// -- State Imports --
import { usePlayerStore } from "../../../state/player/store";
import {
  acquireFineSpectrum,
  getLatestFineSpectrum,
  getLatestLevel,
  getLatestSpectrum,
  smoothBands,
} from "../../../state/player/spectrum";
import { createSignalFollower, restSignal } from "../../../state/player/visualSignal";
import type { GlKind } from "../../../state/player/visualizerKind";

// -- Utils Imports --
import { isDarkTheme } from "../../../theme";

// -- Style Imports --
import styles from "./GlVisualizer.module.css";

// The fine spectrum's ballistics, matching the 24 bands'.
const FINE_ATTACK = 0.5;
const FINE_DECAY = 0.15;
// Layout, theme and blend are re-read on this frame interval rather than every frame.
const REMEASURE_EVERY = 30;

/**
 * One WebGL2 visualizer surface: a canvas filling its positioned parent, drawing the picked kind around
 * the cover. The canvas is made here rather than rendered, so every mount gets a fresh context. The
 * signal and the draw loop stay off React; props reach the loop through a ref, so a kind change swaps
 * candidates on the same context. A missing context, a lost one or a shader error calls `onFail` once.
 * Under a reduced-motion preference it draws one still frame and runs no loop.
 */
export function GlVisualizer({
  kind,
  ambient,
  coverRef,
  maskRef,
  palette,
  pixels,
  onFail,
}: {
  kind: GlKind;
  ambient: boolean;
  coverRef: RefObject<HTMLElement | null>;
  // The element the layer feathers off outside; absent, the whole stage draws.
  maskRef?: RefObject<HTMLElement | null>;
  palette: Float32Array;
  pixels: ImageBitmap | null;
  onFail: () => void;
}) {
  const slotRef = useRef<HTMLDivElement>(null);
  const live = useRef({ kind, palette, pixels, onFail });
  live.current = { kind, palette, pixels, onFail };
  // Reduced motion has no loop; this holds its repaint so a prop change can trigger one.
  const repaintRef = useRef<(() => void) | null>(null);

  // The fine spectrum costs the engine a second analysis, so it runs only while Terrain is up.
  useEffect(() => {
    if (kind !== "terrain") return;
    return acquireFineSpectrum();
  }, [kind]);

  useEffect(() => {
    const slot = slotRef.current;
    if (!slot) return;
    const canvas = document.createElement("canvas");
    canvas.className = styles.canvas;
    slot.appendChild(canvas);

    let failed = false;
    const fail = () => {
      if (failed) return;
      failed = true;
      live.current.onFail();
    };

    let renderer: Renderer | null = null;
    try {
      renderer = createRenderer(canvas);
    } catch {
      renderer = null;
    }
    if (!renderer) {
      fail();
      return () => canvas.remove();
    }
    const r = renderer;

    const onLost = (event: Event) => {
      event.preventDefault();
      fail();
    };
    canvas.addEventListener("webglcontextlost", onLost);

    const measure = () => {
      const stage = canvas.getBoundingClientRect();
      const rel = (el: HTMLElement): Rect => {
        const b = el.getBoundingClientRect();
        return [b.left - stage.left, b.top - stage.top, b.width, b.height];
      };
      const cover = coverRef.current;
      const mask = maskRef?.current ?? null;
      const layout: Layout = {
        width: stage.width,
        height: stage.height,
        cover: cover ? rel(cover) : [stage.width / 2, stage.height / 2, 1, 1],
        radius: cover ? parseFloat(getComputedStyle(cover).borderTopLeftRadius) || 0 : 0,
        mask: mask ? rel(mask) : null,
      };
      r.fit(layout);
    };

    let light = !isDarkTheme();
    // The blend sits on the slot, not the canvas: the slot's z-index makes it an isolated group, so a
    // blend inside it would only see the empty slot instead of the aurora and ground beneath.
    const applyBlend = () => {
      slot.style.mixBlendMode = blendModeFor(live.current.kind, light);
    };
    const draw = (paint: () => void) => {
      if (failed) return;
      try {
        paint();
      } catch {
        fail();
      }
    };
    const frameOf = (t: number, dt: number, still: boolean, fine: number[] | null): Omit<Frame, "sig"> => ({
      t,
      dt,
      palette: live.current.palette,
      light,
      ambient,
      still,
      fine,
      cover: live.current.pixels,
    });

    const teardown = () => {
      canvas.removeEventListener("webglcontextlost", onLost);
      r.dispose();
      canvas.remove();
    };

    if (window.matchMedia("(prefers-reduced-motion: reduce)").matches) {
      const still = () => {
        light = !isDarkTheme();
        measure();
        applyBlend();
        draw(() => r.still(live.current.kind, { ...frameOf(14, 1 / 60, true, null), sig: restSignal() }));
      };
      repaintRef.current = still;
      still();

      const ro = new ResizeObserver(still);
      ro.observe(canvas);
      const themeObs = new MutationObserver(still);
      themeObs.observe(document.documentElement, { attributes: true, attributeFilter: ["data-theme"] });
      const media = window.matchMedia("(prefers-color-scheme: dark)");
      media.addEventListener("change", still);

      return () => {
        repaintRef.current = null;
        ro.disconnect();
        themeObs.disconnect();
        media.removeEventListener("change", still);
        teardown();
      };
    }

    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(canvas);

    const follower = createSignalFollower();
    let fine: number[] | null = null;
    let tick = 0;
    let last = 0;
    let raf = 0;
    const frame = (now: number) => {
      raf = requestAnimationFrame(frame);
      const dt = last ? Math.min(0.05, (now - last) / 1000) : 1 / 60;
      last = now;
      // The cover can move without the stage resizing, and the theme can flip, so both are polled.
      if (tick++ % REMEASURE_EVERY === 0) {
        light = !isDarkTheme();
        measure();
      }
      const playing = usePlayerStore.getState().status.playing;
      const sig = follower.step(dt, { bands: getLatestSpectrum(), level: getLatestLevel(), playing });
      const rawFine = live.current.kind === "terrain" ? getLatestFineSpectrum() : null;
      fine = rawFine ? smoothBands(fine ?? [], rawFine, FINE_ATTACK, FINE_DECAY) : null;
      applyBlend();
      draw(() => r.render(live.current.kind, { ...frameOf(now / 1000, dt, false, fine), sig }));
      if (failed) cancelAnimationFrame(raf);
    };
    raf = requestAnimationFrame(frame);

    return () => {
      cancelAnimationFrame(raf);
      ro.disconnect();
      teardown();
    };
  }, [ambient, coverRef, maskRef]);

  // Reduced motion repaints its still frame when the kind, palette or cover changes; a no-op while animating.
  useEffect(() => {
    repaintRef.current?.();
  }, [kind, palette, pixels]);

  return <div ref={slotRef} className={styles.slot} aria-hidden="true" />;
}
