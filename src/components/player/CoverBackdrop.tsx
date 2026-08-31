// -- Framework Imports --
import { useEffect, useRef, useState } from "react";

interface Layer {
  id: number;
  src: string | null;
}

/**
 * The blurred-cover ground that crossfades when the track changes. CSS cannot transition a
 * background-image, so each cover is its own stacked layer: a new src mounts on top and fades in over
 * the outgoing one, which is dropped once the fade settles. The first, single layer never fades. The
 * `className` is the surface's own `.bg` style - blur, scale and fallback differ per surface (the mini
 * and the widget) - and that class carries the fade via its own `[data-enter]` rule; this only manages
 * the layering.
 */
export function CoverBackdrop({ src, className }: { src: string | null; className: string }) {
  const [layers, setLayers] = useState<Layer[]>(() => [{ id: 0, src }]);
  const nextId = useRef(1);

  useEffect(() => {
    setLayers((prev) => {
      // The same cover (or the same absence) adds no layer; only a real change fades.
      if (prev[prev.length - 1]?.src === src) return prev;
      return [...prev, { id: nextId.current++, src }];
    });
  }, [src]);

  // Once the newest layer has faded fully in, drop every layer beneath it.
  const settle = () => setLayers((prev) => prev.slice(-1));

  return (
    <>
      {layers.map((layer, i) => {
        const top = i === layers.length - 1;
        return (
          <div
            key={layer.id}
            className={className}
            style={layer.src ? { backgroundImage: `url("${layer.src}")` } : undefined}
            data-enter={top && layers.length > 1 ? "" : undefined}
            onAnimationEnd={top ? settle : undefined}
          />
        );
      })}
    </>
  );
}
