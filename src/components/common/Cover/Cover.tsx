// -- Framework Imports --
import { useCallback, useEffect, useRef, useState } from "react";

// -- Icon Imports --
import { Image as ImageIcon } from "lucide-react";

// -- Style Imports --
import styles from "./Cover.module.css";

/**
 * A square cover-as-object: art when given a src, else the sunken placeholder recess. It carries
 * the soft shadow and the inset ring that make it read as a physical tile, plus a faint grain
 * layer. Presentational only - it never touches IPC or path conversion; the caller hands it a
 * ready src. A src that fails to load folds back to the placeholder instead of a broken image.
 *
 * `interactive` only arms the shadow and transform transitions: the lift itself is driven by a
 * parent through the --cover-shadow custom property, which inherits into the tile. Left off, the
 * tile rests on --shadow-soft exactly as before.
 */
export function Cover({
  src,
  alt = "",
  interactive = false,
  onError,
}: {
  src: string | null;
  alt?: string;
  interactive?: boolean;
  onError?: () => void;
}) {
  const [broken, setBroken] = useState(false);
  // The src whose load has completed, rather than a bare boolean: `loaded` is derived from this matching
  // the current src. A boolean plus a reset-on-change effect raced the load event - a cached cover's load
  // could set true before the effect set false, stranding it hidden when switching albums in the open
  // drawer. Deriving off the completed src removes the reset effect and the race with it.
  const [loadedSrc, setLoadedSrc] = useState<string | null>(null);

  // A new src is worth another load attempt after a previous one failed.
  useEffect(() => setBroken(false), [src]);

  // The latest src, read by the stable load callbacks without making them churn on every change.
  const srcRef = useRef(src);
  srcRef.current = src;

  const onLoad = useCallback(() => setLoadedSrc(srcRef.current), []);

  // A cached image can already be complete before React wires onLoad, so no load event ever fires for it;
  // catch that as the node attaches (a cached tile on mount) and mark this src loaded before the first
  // paint, which shows it with no fade. A src change on a kept node still fires onLoad, so this only needs
  // to cover the mount case. A pending image stays at zero opacity until its load event lands.
  const armLoaded = useCallback((node: HTMLImageElement | null) => {
    if (node?.complete && node.naturalWidth > 0) setLoadedSrc(srcRef.current);
  }, []);

  const showArt = src != null && !broken;
  // Loaded only when the completed src is the one on screen now; a fresh src fades in on its own load.
  const loaded = showArt && loadedSrc === src;

  return (
    <div className={interactive ? `${styles.cover} ${styles.interactive}` : styles.cover}>
      {showArt ? (
        <img
          ref={armLoaded}
          className={styles.art}
          src={src}
          alt={alt}
          data-loaded={loaded ? "" : undefined}
          // Decode off the main thread so a wall of full-res covers never janks the scroll; the browser
          // still only decodes tiles it paints, so an off-screen cover costs nothing until it scrolls in.
          decoding="async"
          onLoad={onLoad}
          onError={() => {
            setBroken(true);
            onError?.();
          }}
        />
      ) : (
        <span className={styles.placeholder} aria-hidden="true">
          <ImageIcon size={30} strokeWidth={1.6} />
        </span>
      )}
      <span className={styles.grain} aria-hidden="true" />
    </div>
  );
}
