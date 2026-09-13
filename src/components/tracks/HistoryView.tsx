// -- Framework Imports --
import { useEffect, useMemo, useState } from "react";
import type { CSSProperties } from "react";

// -- Icon Imports --
import { LayoutGrid, Rows3 } from "lucide-react";

// -- Component Imports --
import { TrackGrid } from "./TrackGrid";
import { TimelineList } from "./TimelineList";
import { TrackDetail } from "./TrackDetail";
import { MostWindowControl } from "./MostWindowControl";
import { EmptyState } from "../common/EmptyState";
import { Resizer } from "../common/Resizer/Resizer";
import { SegmentedControl } from "../common/SegmentedControl";

// -- Hook Imports --
import { useDrawerResize } from "../common/Resizer/useDrawerResize";

// -- State Imports --
import { useAlbumIndex } from "../../state/organize/store";
import { useHistory, usePlayTimeline } from "../../state/player/playHistory";

// -- Utils Imports --
import { historyMostColumns, historyRecentColumns } from "./trackColumns";

// -- Type Imports --
import type { MostWindow } from "./MostWindowControl";
import type { HistoryLens } from "../../state/shell/store";
import type { FilesViewMode, GridSort } from "../../state/store";
import type { TrackRow } from "../../types";

// -- i18n Imports --
import { useT } from "../../i18n";

// -- Style Imports --
import styles from "./HistoryView.module.css";

/** The play-log column each lens sorts on by default, newest/most first. */
function seedSort(lens: HistoryLens): GridSort {
  return [{ id: lens === "recent" ? "last_played" : "plays", desc: true }];
}

/** Each rolling window's day span; all-time carries none. */
const WINDOW_DAYS: Record<MostWindow, number> = { all: 0, last30: 30, last365: 365 };

/** The play-log `since` floor for a window, or undefined for all-time (no cutoff). */
function windowToSince(window: MostWindow, nowSecs: number): number | undefined {
  const days = WINDOW_DAYS[window];
  return days === 0 ? undefined : nowSecs - days * 86400;
}

/**
 * History: the whole listening log on one flat surface, the "See all" behind the Home recently- and
 * most-played previews. A header lens toggle swaps between the deduped recently-played list (a relative
 * last-played age), the raw play-count ranking, and the raw chronological timeline. The first two ride
 * the same collection grid with its search, column sort, and list/cards toggle; their rows and play-log
 * stat come from useHistory. The timeline repeats a track once per play, so it cannot key by track id
 * like the grid - it renders a bespoke day-grouped list from usePlayTimeline instead, dropping the
 * search and view toggle and counting plays, not tracks. The album index joins under every lens so a
 * member's album cell resolves. Playing a grid row queues the shown rows; a timeline row plays alone.
 */
export function HistoryView({ initialLens }: { initialLens: HistoryLens }) {
  const t = useT();
  const albumIndex = useAlbumIndex();
  const [lens, setLens] = useState<HistoryLens>(initialLens);
  const isTimeline = lens === "timeline";
  // The most-played window survives a lens flip, so a return to the ranking keeps the chosen span.
  const [mostWindow, setMostWindow] = useState<MostWindow>("all");
  // The floor lands only on the most lens; recomputed when the window flips, so it stays a rolling cut
  // without refetching on every render. A narrower window than all-time narrows which plays score.
  const mostSince = useMemo(
    () => (lens === "most" ? windowToSince(mostWindow, Math.floor(Date.now() / 1000)) : undefined),
    [lens, mostWindow],
  );
  // Both lens sources stay resident so a toggle swaps to data already in hand, never through an empty
  // frame. useHistory only knows recent/most, so under the timeline it holds the recent rows it never
  // renders. The timeline draws its own raw log.
  const { rows, stats } = useHistory(isTimeline ? "recent" : lens, mostSince);
  const timeline = usePlayTimeline();

  const [search, setSearch] = useState("");
  const [view, setView] = useState<FilesViewMode>("table");
  const [sort, setSort] = useState<GridSort>(seedSort(initialLens));
  const [selected, setSelected] = useState<TrackRow | null>(null);
  const [visibleCount, setVisibleCount] = useState(rows.length);
  const { width, containerRef, resizer } = useDrawerResize();

  // A lens flip is a different column set, so it reseeds the sort onto that lens's play-log column
  // rather than stranding on a column the other lens does not carry.
  useEffect(() => {
    setSort(seedSort(lens));
  }, [lens]);

  const activeEmpty = (isTimeline ? timeline.length : rows.length) === 0;
  // A most-lens window that resolves to nothing keeps the header, so its window and lens stay reachable
  // to widen back out; that empty rests in the body. Nothing-ever (no window) is the onboarding rest and
  // takes the whole surface. The grid's own no-match empty covers a narrowed search.
  const windowedEmpty = activeEmpty && lens === "most" && mostWindow !== "all";
  if (activeEmpty && !windowedEmpty) {
    return (
      <EmptyState
        tone="idle"
        title={t((d) => d.history.emptyTitle)}
        line={t((d) => d.history.emptyLine)}
      />
    );
  }

  return (
    <div className={styles.view}>
      <div className={styles.header}>
        <h1 className={styles.title}>{t((d) => d.nav.history)}</h1>
        <div className={styles.lens}>
          <SegmentedControl
            segments={[
              { value: "recent", label: t((d) => d.history.recent) },
              { value: "most", label: t((d) => d.history.most) },
              { value: "timeline", label: t((d) => d.history.timeline) },
            ]}
            value={lens}
            onChange={setLens}
            label={t((d) => d.history.title)}
          />
        </div>
        <span className={styles.count}>
          {isTimeline
            ? t((d) => d.history.playCount, { n: timeline.length })
            : t((d) => d.tracks.count, { n: rows.length === 0 ? 0 : visibleCount })}
        </span>
        {/* The ranking window rides the most lens alone; recent and timeline carry no window. */}
        {lens === "most" ? (
          <div className={styles.window}>
            <MostWindowControl value={mostWindow} onChange={setMostWindow} />
          </div>
        ) : null}
        {/* The list/cards toggle governs the grid alone; the timeline is a single fixed layout. */}
        {isTimeline ? null : (
          <div className={styles.viewToggle}>
            <SegmentedControl
              segments={[
                {
                  value: "table",
                  label: t((d) => d.tracks.viewList),
                  icon: <Rows3 size={15} strokeWidth={1.8} aria-hidden="true" />,
                },
                {
                  value: "cards",
                  label: t((d) => d.tracks.viewCards),
                  icon: <LayoutGrid size={15} strokeWidth={1.8} aria-hidden="true" />,
                },
              ]}
              value={view}
              onChange={setView}
              label={t((d) => d.tracks.view)}
            />
          </div>
        )}
      </div>

      <div
        className={styles.body}
        ref={containerRef}
        style={{ "--drawer-width": `${width}px` } as CSSProperties}
      >
        {windowedEmpty ? (
          <EmptyState
            tone="idle"
            title={t((d) => d.history.emptyTitle)}
            line={t((d) => d.history.emptyWindowLine)}
          />
        ) : isTimeline ? (
          <TimelineList
            entries={timeline}
            albumIndex={albumIndex}
            selectedId={selected?.id ?? null}
            onSelect={setSelected}
          />
        ) : (
          <TrackGrid
            tracks={rows}
            view={view}
            columns={lens === "recent" ? historyRecentColumns : historyMostColumns}
            albumIndex={albumIndex}
            historyIndex={stats}
            enableFacets={false}
            source={{ kind: "history" }}
            sort={sort}
            onSortChange={setSort}
            search={search}
            onSearchChange={setSearch}
            onVisibleCount={setVisibleCount}
            selectedId={selected?.id ?? null}
            onSelect={setSelected}
          />
        )}
        {selected ? (
          <div className={styles.panel}>
            <Resizer resizer={resizer} />
            <TrackDetail track={selected} onClose={() => setSelected(null)} />
          </div>
        ) : null}
      </div>
    </div>
  );
}
