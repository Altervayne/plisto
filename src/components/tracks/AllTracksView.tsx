// -- Framework Imports --
import { useState } from "react";
import type { CSSProperties } from "react";

// -- Icon Imports --
import { LayoutGrid, Rows3 } from "lucide-react";

// -- Component Imports --
import { TrackGrid } from "./TrackGrid";
import { TrackDetail } from "./TrackDetail";
import { EmptyState } from "../common/EmptyState";
import { Resizer } from "../common/Resizer/Resizer";
import { SegmentedControl } from "../common/SegmentedControl";

// -- Hook Imports --
import { useDrawerResize } from "../common/Resizer/useDrawerResize";

// -- State Imports --
import {
  useLibraryFacets,
  useLibraryGroupBy,
  useLibrarySearch,
  useLibrarySort,
  useLibraryView,
  useSetLibraryFacets,
  useSetLibraryGroupBy,
  useSetLibrarySearch,
  useSetLibrarySort,
  useSetLibraryView,
  useTracks,
} from "../../state/store";

// -- Utils Imports --
import { collectionColumns } from "./trackColumns";

// -- Type Imports --
import type { TrackRow } from "../../types";

// -- i18n Imports --
import { useT } from "../../i18n";

// -- Style Imports --
import styles from "./AllTracksView.module.css";

/**
 * All Tracks: every track in the library on one flat, metadata-organized surface. No folder tree, no
 * breadcrumb, no lens - just the collection grid with its search, facet filter, and column sort, over
 * the library's own store slice so its filters never touch the Files browser. A row peek opens beside
 * the grid, mirroring the album and Files split.
 */
export function AllTracksView() {
  const tracks = useTracks();
  const t = useT();

  const sort = useLibrarySort();
  const setSort = useSetLibrarySort();
  const search = useLibrarySearch();
  const setSearch = useSetLibrarySearch();
  const facets = useLibraryFacets();
  const setFacets = useSetLibraryFacets();
  const groupBy = useLibraryGroupBy();
  const setGroupBy = useSetLibraryGroupBy();
  const view = useLibraryView();
  const setView = useSetLibraryView();

  const [selected, setSelected] = useState<TrackRow | null>(null);
  // The filtered row count reported up from the grid, so the header counts the narrowed view rather than
  // the whole library. It seeds at the total, the value an unfiltered grid reports back at once.
  const [visibleCount, setVisibleCount] = useState(tracks.length);
  const { width, containerRef, resizer } = useDrawerResize();

  // An empty library rests on the add-a-folder on-ramp, pointing at Settings the way the album wall does.
  if (tracks.length === 0) {
    return (
      <EmptyState
        tone="idle"
        title={t((d) => d.tracks.emptyTitle)}
        line={t((d) => d.tracks.emptyLine)}
      />
    );
  }

  return (
    <div className={styles.view}>
      <div className={styles.header}>
        <h1 className={styles.title}>{t((d) => d.nav.tracks)}</h1>
        <span className={styles.count}>{t((d) => d.tracks.count, { n: visibleCount })}</span>
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
      </div>

      <div
        className={styles.body}
        ref={containerRef}
        style={{ "--drawer-width": `${width}px` } as CSSProperties}
      >
        <TrackGrid
          view={view}
          enableFacets
          columns={collectionColumns}
          source={{ kind: "tracks" }}
          sort={sort}
          onSortChange={setSort}
          search={search}
          onSearchChange={setSearch}
          facets={facets}
          onFacetsChange={setFacets}
          groupBy={groupBy}
          onGroupByChange={setGroupBy}
          onVisibleCount={setVisibleCount}
          selectedId={selected?.id ?? null}
          onSelect={setSelected}
        />
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
