// -- Framework Imports --
import { useEffect, useRef, useState } from "react";

// -- Component Imports --
import { Cover } from "../../common/Cover/Cover";

// -- Utils Imports --
import { loadCachedCover } from "../../covers/useTrackThumb";

// -- Type Imports --
import type { TrackRow } from "../../../types";

// -- Style Imports --
import styles from "./ProposalRow.module.css";

/**
 * A proposal's small cover: the art of the first track in play order that has any. It waits until the
 * row scrolls into view, then walks the tracks through the shared thumb cache and stops at the first hit,
 * so a long list only reads covers for the rows actually seen.
 */
export function ProposalCover({ tracks }: { tracks: TrackRow[] }) {
  const ref = useRef<HTMLSpanElement>(null);
  const [seen, setSeen] = useState(false);
  const [src, setSrc] = useState<string | null>(null);

  useEffect(() => {
    const el = ref.current;
    if (!el || seen) return;
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) {
        setSeen(true);
        observer.disconnect();
      }
    });
    observer.observe(el);
    return () => observer.disconnect();
  }, [seen]);

  useEffect(() => {
    if (!seen) return;
    let alive = true;
    void (async () => {
      for (const track of tracks) {
        const found = await loadCachedCover(track.id, "thumb").catch(() => null);
        if (!alive) return;
        if (found) {
          setSrc(found);
          return;
        }
      }
    })();
    return () => {
      alive = false;
    };
  }, [seen, tracks]);

  return (
    <span ref={ref} className={styles.cover}>
      <Cover src={src} />
    </span>
  );
}
