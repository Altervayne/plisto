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
  const [loaded, setLoaded] = useState(false);

  // A new src is worth another load attempt after a previous one failed.
  useEffect(() => setBroken(false), [src]);

  // Re-arm the fade when the src changes on a kept tile, but not on the first mount: an initial cached hit
  // is caught below before the first paint, and clearing it here would strand it hidden with no load event.
  const first = useRef(true);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    setLoaded(false);
  }, [src]);

  const onLoad = useCallback(() => setLoaded(true), []);

  // A cached image can already be complete before React wires onLoad, so no load event ever fires; catch
  // that as the node attaches and mark it loaded before the first paint, which shows it with no fade. A
  // pending image stays at zero opacity until its load event arms the transition.
  const armLoaded = useCallback((node: HTMLImageElement | null) => {
    if (node?.complete) setLoaded(true);
  }, []);

  const showArt = src != null && !broken;

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
