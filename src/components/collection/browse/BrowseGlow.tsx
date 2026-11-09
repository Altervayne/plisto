// -- Framework Imports --
import { useEffect, useLayoutEffect, useRef, useState, useSyncExternalStore } from "react";

// -- Hook Imports --
import { useAlbumPalette } from "../../covers/useAlbumPalette";

// -- Utils Imports --
import { isDarkTheme, subscribeTheme } from "../../../theme";
import { derivePaletteTone } from "../../covers/paletteTone";

// -- Type Imports --
import type { Rgb } from "../../covers/paletteTone";

// -- Style Imports --
import styles from "./BrowseGlow.module.css";

/** Layers kept at once: the one fading in and the ones still fading out under a fast scrub. */
const MAX_LAYERS = 3;

/** The cross-fade, matching the layer's opacity transition. */
const FADE_MS = 1100;

// The aurora's theme split: a plain blend at low strength on light, screen at more on dark.
const OPACITY_LIGHT = 0.3;
const OPACITY_DARK = 0.5;

/** The three blooms, placed around the focused cover. */
function glowBackground([a, b, c]: Rgb[]): string {
  const rgb = ({ r, g, b: blue }: Rgb) => `rgb(${r}, ${g}, ${blue})`;
  return [
    `radial-gradient(42% 46% at 36% 44%, ${rgb(a)}, transparent 72%)`,
    `radial-gradient(40% 44% at 66% 52%, ${rgb(b)}, transparent 72%)`,
    `radial-gradient(34% 36% at 52% 34%, ${rgb(c)}, transparent 70%)`,
  ].join(", ");
}

interface Layer {
  id: number;
  background: string;
  opacity: number;
  blend: "normal" | "screen";
  on: boolean;
}

/**
 * The cover-palette glow behind the focused record: blurred blooms in the album's tempered colours,
 * or the warm neutral tint for a cover-less or near-gray one. A new focus or theme lays a fresh layer
 * that cross-fades over the old, which leaves once faded. Reduced motion swaps the layer at once and
 * holds it still.
 */
export function BrowseGlow({ albumId, reduced }: { albumId: number; reduced: boolean }) {
  const palette = useAlbumPalette(albumId);
  const dark = useSyncExternalStore(subscribeTheme, isDarkTheme);
  const [layers, setLayers] = useState<Layer[]>([]);
  const nextId = useRef(0);
  const freshRef = useRef<HTMLDivElement | null>(null);
  const timers = useRef(new Set<ReturnType<typeof setTimeout>>());

  useEffect(() => {
    const pending = timers.current;
    return () => pending.forEach(clearTimeout);
  }, []);

  useEffect(() => {
    const tone = derivePaletteTone(palette, dark, 3);
    const layer: Layer = {
      id: nextId.current++,
      background: glowBackground(tone.colors),
      opacity: (dark ? OPACITY_DARK : OPACITY_LIGHT) * tone.opacityFactor,
      blend: dark ? "screen" : "normal",
      on: reduced,
    };
    setLayers((prev) => (reduced ? [layer] : [...prev, layer].slice(-MAX_LAYERS)));
  }, [palette, dark, reduced]);

  // The fresh layer has painted at zero: flush that style, then turn it on and the rest off, so the
  // opacity transition runs both ways. The old layers leave once their fade is done.
  useLayoutEffect(() => {
    const fresh = layers[layers.length - 1];
    if (!fresh || fresh.on) return;
    void freshRef.current?.offsetWidth;
    setLayers((prev) => prev.map((layer) => ({ ...layer, on: layer.id === fresh.id })));
    const timer = setTimeout(() => {
      timers.current.delete(timer);
      setLayers((prev) => prev.filter((layer) => layer.id >= fresh.id));
    }, FADE_MS);
    timers.current.add(timer);
  }, [layers]);

  return (
    <div className={styles.glowbox} data-reduced={reduced ? "" : undefined} aria-hidden="true">
      {layers.map((layer, i) => (
        <div
          key={layer.id}
          ref={i === layers.length - 1 ? freshRef : undefined}
          className={styles.glow}
          style={{
            background: layer.background,
            mixBlendMode: layer.blend,
            opacity: layer.on ? layer.opacity : 0,
          }}
        />
      ))}
    </div>
  );
}
