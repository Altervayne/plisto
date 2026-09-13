/*
 * The Timeline lens for History: a raw chronological play-log, one row per listen, newest first, grouped
 * by local calendar day. Unlike the recently- and most-played lenses this cannot ride TrackGrid, which
 * keys rows by track id and assumes each track appears once; the timeline repeats a track once per play,
 * so it keys rows by the play id instead. It reuses the collection row's visual grammar and the shared
 * TrackDetail peek, virtualizing a flattened [day header | play row] list the way the grid windows its
 * grouped body.
 */

// -- Framework Imports --
import { useCallback, useMemo, useRef } from "react";
import type { CSSProperties } from "react";

// -- Library Imports --
import { useVirtualizer } from "@tanstack/react-virtual";

// -- Icon Imports --
import { Play } from "lucide-react";

// -- Component Imports --
import { ScrollArea } from "../common/ScrollArea/ScrollArea";
import { Tooltip } from "../common/Tooltip/Tooltip";

// -- State Imports --
import { usePlayerActions, usePlayerEnabled } from "../../state/player/store";

// -- Utils Imports --
import { resolveTrackAlbum } from "./trackAlbum";
import { dayKey, formatClockTime } from "../../lib/format";

// -- Type Imports --
import type { TimelineEntry } from "../../state/player/playHistory";
import type { AlbumRow, TrackRow } from "../../types";

// -- i18n Imports --
import { useLocale, useT } from "../../i18n";

// -- Style Imports --
import styles from "./TimelineList.module.css";

const ROW_HEIGHT = 40;
// The seed height for a day header, corrected once it measures. It only trims the first paint's layout
// shift, so an approximation is enough.
const DAY_HEADER_HEIGHT = 56;

/** One flattened list item: a day header or a play row. The virtualizer windows this flat sequence. */
type TimelineItem =
  | { type: "header"; dayKey: string; label: string; count: number }
  | { type: "row"; entry: TimelineEntry };

/** The displayed value or a deliberate quiet dash for an absent tag. */
function orDash(value: string | null): string {
  return value && value.length > 0 ? value : "-";
}

/** A secondary tag cell: quiet dash for an absent value, a hover tooltip when the text truncates. */
function Cell({ text }: { text: string }) {
  const empty = text === "-";
  const cell = (
    <span className={`${styles.cell} ${styles.secondary} ${empty ? styles.empty : ""}`}>{text}</span>
  );
  return empty ? cell : <Tooltip label={text}>{cell}</Tooltip>;
}

/**
 * The day-grouped play-log list. `entries` arrive newest-first and already resolved to library rows;
 * `albumIndex` joins each row to the album it is filed into so its album cell reads the container.
 * `selectedId` marks the peeked track and `onSelect` opens the shared peek in HistoryView's split.
 */
export function TimelineList({
  entries,
  albumIndex,
  selectedId,
  onSelect,
}: {
  entries: TimelineEntry[];
  albumIndex: Map<number, AlbumRow>;
  selectedId: number | null;
  onSelect: (track: TrackRow) => void;
}) {
  const t = useT();
  const locale = useLocale();
  const playerEnabled = usePlayerEnabled();
  const { play } = usePlayerActions();

  // The day-header label: Today or Yesterday when it matches, else a localized weekday and date. The
  // today/yesterday boundary is a local calendar-day comparison, so it never drifts on a DST edge.
  const dayLabel = useCallback(
    (stamp: number): string => {
      const nowSecs = Math.floor(Date.now() / 1000);
      const key = dayKey(stamp);
      if (key === dayKey(nowSecs)) return t((d) => d.history.today);
      const yesterday = new Date();
      yesterday.setDate(yesterday.getDate() - 1);
      if (key === dayKey(Math.floor(yesterday.getTime() / 1000))) {
        return t((d) => d.history.yesterday);
      }
      return new Intl.DateTimeFormat(locale, {
        weekday: "long",
        month: "short",
        day: "numeric",
      }).format(new Date(stamp * 1000));
    },
    [t, locale],
  );

  // Bucket the newest-first entries by local calendar day, holding insertion order so the newest day and
  // its newest play both lead. Each bucket contributes a header then its rows to the flattened list.
  const flat = useMemo(() => {
    const buckets = new Map<string, TimelineEntry[]>();
    for (const entry of entries) {
      const key = dayKey(entry.playedAt);
      const bucket = buckets.get(key);
      if (bucket) bucket.push(entry);
      else buckets.set(key, [entry]);
    }
    const items: TimelineItem[] = [];
    for (const [key, bucket] of buckets) {
      items.push({ type: "header", dayKey: key, label: dayLabel(bucket[0].playedAt), count: bucket.length });
      for (const entry of bucket) items.push({ type: "row", entry });
    }
    return items;
  }, [entries, dayLabel]);

  // The ScrollArea hands its viewport here so the virtualizer scrolls this surface. Keying by content,
  // not index, pins a measured header height to its day; a header runs taller than a row, so its exact
  // height is measured and the estimate is only the seed.
  const scrollRef = useRef<HTMLDivElement | null>(null);
  const getItemKey = useCallback(
    (index: number) => {
      const item = flat[index];
      if (!item) return index;
      return item.type === "header" ? `h:${item.dayKey}` : `r:${item.entry.playId}`;
    },
    [flat],
  );
  const virtualizer = useVirtualizer({
    count: flat.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: (index) => (flat[index]?.type === "header" ? DAY_HEADER_HEIGHT : ROW_HEIGHT),
    getItemKey,
    overscan: 8,
  });

  // Play sends the one clicked track on its own, the source carrying its title for the "playing from"
  // line; the log is the past, so it never queues the whole timeline. Off when the player is disabled.
  const onPlay = playerEnabled
    ? (track: TrackRow) => {
        const label = track.title_edit ?? track.raw_title ?? track.filename;
        play([track.id], 0, { kind: "single", id: track.id, label });
      }
    : undefined;

  return (
    <div className={styles.list}>
      <ScrollArea
        className={styles.scroll}
        contentClassName={styles.scrollInner}
        viewportRef={scrollRef}
      >
        <div className={styles.body} style={{ height: virtualizer.getTotalSize() }}>
          {virtualizer.getVirtualItems().map((item) => {
            const entry = flat[item.index];
            if (!entry) return null;
            const y: CSSProperties = { transform: `translateY(${item.start}px)` };

            if (entry.type === "header") {
              const cls = `${styles.header} ${item.index === 0 ? styles.headerFirst : ""}`;
              return (
                <div
                  key={`h:${entry.dayKey}`}
                  ref={virtualizer.measureElement}
                  data-index={item.index}
                  className={cls}
                  style={y}
                >
                  <span className={styles.dayLabel}>{entry.label}</span>
                  <span className={styles.dayCount}>
                    {t((d) => d.history.playCount, { n: entry.count })}
                  </span>
                </div>
              );
            }

            const { track, playedAt, completed, playId } = entry.entry;
            const playable = track.missing_at == null;
            const active = track.id === selectedId;
            const title = track.title_edit ?? track.raw_title ?? track.filename;
            const artist = orDash(track.artist_edit ?? track.raw_artist);
            const album = orDash(resolveTrackAlbum(track, albumIndex));

            // The play triangle, armed only when the player is on. A gone source greys it inert with its
            // reason on hover.
            const glyph = onPlay ? (
              <span
                className={playable ? styles.play : `${styles.play} ${styles.playOff}`}
                aria-hidden="true"
                onClick={(e) => {
                  e.stopPropagation();
                  if (playable) onPlay(track);
                }}
              >
                <Play size={12} strokeWidth={2} fill="currentColor" />
              </span>
            ) : null;
            const armedGlyph =
              glyph == null || playable ? (
                glyph
              ) : (
                <Tooltip label={t((d) => d.player.fileMissing)}>{glyph}</Tooltip>
              );

            return (
              <div
                key={`r:${playId}`}
                className={`${styles.row} ${active ? styles.active : ""}`}
                style={y}
                role="button"
                tabIndex={0}
                aria-label={track.raw_title ?? track.filename}
                onClick={() => onSelect(track)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" || e.key === " ") {
                    e.preventDefault();
                    onSelect(track);
                  }
                }}
              >
                <span className={styles.gutter}>{armedGlyph}</span>
                <Tooltip label={title}>
                  <span className={`${styles.cell} ${styles.title}`}>{title}</span>
                </Tooltip>
                <Cell text={artist} />
                <Cell text={album} />
                <span className={styles.stamp}>
                  <span
                    className={`${styles.dot} ${completed ? styles.dotFull : styles.dotPartial}`}
                    role="img"
                    aria-label={
                      completed ? t((d) => d.history.completedPlay) : t((d) => d.history.partialPlay)
                    }
                  />
                  {formatClockTime(playedAt)}
                </span>
              </div>
            );
          })}
        </div>
      </ScrollArea>
    </div>
  );
}
