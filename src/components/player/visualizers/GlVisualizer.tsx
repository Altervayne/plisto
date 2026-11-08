// -- Framework Imports --
import { useEffect, useRef } from "react";
import type { RefObject } from "react";

// -- Local Imports --
import { blendModeFor, createRenderer, type Layout, type Renderer } from "./gl/renderer";
import { clamp01 } from "./gl/cozy";
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
import { needsFineSpectrum, type GlKind, type Reactivity } from "../../../state/player/visualizerKind";

// -- Utils Imports --
import { isDarkTheme } from "../../../theme";

// -- Style Imports --
import styles from "./GlVisualizer.module.css";

// The fine spectrum's ballistics, matching the 24 bands'.
const FINE_ATTACK = 0.5;
const FINE_DECAY = 0.15;
// Layout, theme and blend are re-read on this frame interval rather than every frame.
const REMEASURE_EVERY = 30;

/** Reads a color token as sRGB in 0..1, through the slot's own computed color. */
function tokenRgb(el: HTMLElement, token: string): [number, number, number] {
  el.style.color = `var(${token})`;
  const m = getComputedStyle(el).color.match(/[\d.]+/g);
  return m && m.length >= 3 ? [Number(m[0]) / 255, Number(m[1]) / 255, Number(m[2]) / 255] : [0, 0, 0];
}

/**
 * One WebGL2 visualizer surface: a canvas filling its positioned parent, drawing the picked kind around
 * the cover and hushing behind the given text blocks. The canvas is made here rather than rendered, so
 * every mount gets a fresh context. The signal and the draw loop stay off React; props reach the loop
 * through a ref, so a kind change swaps candidates on the same context. A missing context, a lost one or
 * a shader error calls `onFail` once. Under a reduced-motion preference it draws one still frame and runs
 * no loop.
 */
export function GlVisualizer({
  kind,
  ambient,
  coverRef,
  maskRef,
  floorRef,
  hushRefs,
  palette,
  reactivity,
  pixels,
  mirrored,
  onFail,
}: {
  kind: GlKind;
  ambient: boolean;
  coverRef: RefObject<HTMLElement | null>;
  // The element the layer feathers off outside; absent, the whole stage draws.
  maskRef?: RefObject<HTMLElement | null>;
  // The element whose top edge the layer rests on, such as the seek bar.
  floorRef?: RefObject<HTMLElement | null>;
  // The text blocks the layer may quiet itself behind, such as the source line and the title. A stable
  // list: a new one remounts the surface.
  hushRefs?: readonly RefObject<HTMLElement | null>[];
  palette: Float32Array;
  reactivity: Reactivity;
  pixels: ImageBitmap | null;
  // The dot spectrum mirrors its columns from the centre.
  mirrored: boolean;
  onFail: () => void;
}) {
  const slotRef = useRef<HTMLDivElement>(null);
  const live = useRef({ kind, palette, reactivity, pixels, mirrored, onFail });
  live.current = { kind, palette, reactivity, pixels, mirrored, onFail };
  // Reduced motion has no loop; this holds its repaint so a prop change can trigger one.
  const repaintRef = useRef<(() => void) | null>(null);

  // The fine spectrum costs the engine a second analysis, so it runs only while a kind that draws it is up.
  const fineWanted = needsFineSpectrum(kind);
  useEffect(() => {
    if (!fineWanted) return;
    return acquireFineSpectrum();
  }, [fineWanted]);

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
      const toStage = (b: DOMRect): Rect => [b.left - stage.left, b.top - stage.top, b.width, b.height];
      const rel = (el: HTMLElement): Rect => toStage(el.getBoundingClientRect());
      const cover = coverRef.current;
      const mask = maskRef?.current ?? null;
      const floor = floorRef?.current ?? null;
      // A text block's box can span its column, so the hush takes the extent of the words inside it.
      const hush: Rect[] = [];
      for (const ref of hushRefs ?? []) {
        const el = ref.current;
        if (!el) continue;
        const words = document.createRange();
        words.selectNodeContents(el);
        const box = words.getBoundingClientRect();
        if (box.width > 0 && box.height > 0) hush.push(toStage(box));
      }
      const layout: Layout = {
        width: stage.width,
        height: stage.height,
        cover: cover ? rel(cover) : [stage.width / 2, stage.height / 2, 1, 1],
        radius: cover ? parseFloat(getComputedStyle(cover).borderTopLeftRadius) || 0 : 0,
        mask: mask ? rel(mask) : null,
        floor: floor ? rel(floor)[1] : null,
        hush,
      };
      r.fit(layout);
      backing = tokenRgb(slot, light ? "--surface-2" : "--sunken");
      ground = tokenRgb(slot, ambient ? "--bg" : "--surface");
    };

    let light = !isDarkTheme();
    let backing: [number, number, number] = [0, 0, 0];
    let ground: [number, number, number] = [0, 0, 0];
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
    const progressOf = (): number | null => {
      const { position_secs, duration_secs } = usePlayerStore.getState().status;
      return duration_secs > 0 ? clamp01(position_secs / duration_secs) : null;
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
      mirrored: live.current.mirrored,
      backing,
      ground,
      progress: progressOf(),
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
      const sig = follower.step(dt, {
        bands: getLatestSpectrum(),
        level: getLatestLevel(),
        playing,
        reactivity: live.current.reactivity,
      });
      const rawFine = needsFineSpectrum(live.current.kind) ? getLatestFineSpectrum() : null;
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
  }, [ambient, coverRef, maskRef, floorRef, hushRefs]);

  // Reduced motion repaints its still frame when the kind, palette, cover or layout changes; a no-op while
  // animating.
  useEffect(() => {
    repaintRef.current?.();
  }, [kind, palette, pixels, mirrored]);

  return <div ref={slotRef} className={styles.slot} aria-hidden="true" />;
}
