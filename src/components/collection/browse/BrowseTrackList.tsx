// -- Framework Imports --
import { useEffect, useLayoutEffect, useRef, useState } from "react";
import type { CSSProperties } from "react";

// -- Component Imports --
import { ScrollArea } from "../../common/ScrollArea/ScrollArea";

// -- Utils Imports --
import { groupByDisc } from "../../albums/albumLayout";
import { formatDuration } from "../../../lib/format";

// -- Type Imports --
import type { AlbumTrackRow } from "../../../types";

// -- i18n Imports --
import { useT } from "../../../i18n";

// -- Style Imports --
import styles from "./BrowseTrackList.module.css";

/** How long the focus rests before its track list unfolds, so a scrub never flashes every list. */
const DWELL_MS = 420;

/** A disc with more tracks than this sets them in two columns. */
const ONE_COLUMN_MAX = 6;

/** The stagger stops growing here, so a long box set still unfolds in a beat. */
const STAGGER_MAX = 16;

/**
 * The focused record's tracks, unfolding under it as typography once the focus rests. Several discs
 * read as "Disc N" blocks, each numbered from 1; one disc has no label. The box keeps a fixed height
 * and scrolls within itself, fading at the edge that has more, so a long box set never moves the
 * shelf. Mount it keyed by album, so a new focus starts folded and scrolled to the top. A track click
 * plays the record from that track while the player is on.
 */
export function BrowseTrackList({
  tracks,
  reduced,
  onPlayFrom,
}: {
  tracks: AlbumTrackRow[];
  reduced: boolean;
  /** Absent while the player is off: the rows are text only. */
  onPlayFrom?: (index: number) => void;
}) {
  const t = useT();
  const viewportRef = useRef<HTMLDivElement | null>(null);
  const [open, setOpen] = useState(reduced);
  const [edges, setEdges] = useState({ above: false, below: false });

  useEffect(() => {
    if (reduced) {
      setOpen(true);
      return;
    }
    const timer = window.setTimeout(() => setOpen(true), DWELL_MS);
    return () => window.clearTimeout(timer);
  }, [reduced]);

  useLayoutEffect(() => {
    const viewport = viewportRef.current;
    if (!viewport) return;
    const sync = () => {
      const above = viewport.scrollTop > 2;
      const below = viewport.scrollTop + viewport.clientHeight < viewport.scrollHeight - 2;
      setEdges((prev) => (prev.above === above && prev.below === below ? prev : { above, below }));
    };
    sync();
    viewport.addEventListener("scroll", sync, { passive: true });
    return () => viewport.removeEventListener("scroll", sync);
  }, [tracks]);

  const groups = groupByDisc(tracks);
  const multi = groups.length > 1;
  let k = 0;
  let flat = 0;

  return (
    <div
      className={styles.tracks}
      data-open={open ? "" : undefined}
      data-above={edges.above ? "" : undefined}
      data-below={edges.below ? "" : undefined}
      data-reduced={reduced ? "" : undefined}
    >
      <ScrollArea className={styles.scroll} viewportRef={viewportRef}>
        {groups.map((group) => (
          <div key={group.disc} className={styles.disc}>
            {multi ? (
              <div
                className={styles.discLabel}
                style={{ "--k": Math.min(STAGGER_MAX, k) } as CSSProperties}
              >
                {t((d) => d.albums.discLabel, { n: group.disc })}
              </div>
            ) : null}
            <ol
              className={
                group.rows.length > ONE_COLUMN_MAX ? `${styles.list} ${styles.two}` : styles.list
              }
            >
              {group.rows.map((row, i) => {
                const index = flat++;
                return (
                  <li
                    key={row.track_id}
                    className={onPlayFrom ? `${styles.row} ${styles.playable}` : styles.row}
                    style={{ "--k": Math.min(STAGGER_MAX, k++) } as CSSProperties}
                    onClick={onPlayFrom ? () => onPlayFrom(index) : undefined}
                  >
                    <span className={styles.no}>{i + 1}</span>
                    <span className={styles.title}>
                      {row.title_override ?? row.raw_title ?? row.filename}
                    </span>
                    <span className={styles.duration}>{formatDuration(row.duration_secs)}</span>
                  </li>
                );
              })}
            </ol>
          </div>
        ))}
      </ScrollArea>
    </div>
  );
}
