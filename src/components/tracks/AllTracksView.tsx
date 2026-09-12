// -- Framework Imports --
import { useState } from "react";
import type { CSSProperties } from "react";

// -- Component Imports --
import { TrackGrid } from "./TrackGrid";
import { TrackDetail } from "./TrackDetail";
import { EmptyState } from "../common/EmptyState";
import { Resizer } from "../common/Resizer/Resizer";

// -- Hook Imports --
import { useDrawerResize } from "../common/Resizer/useDrawerResize";

// -- State Imports --
import {
  useLibraryFacets,
  useLibrarySearch,
  useLibrarySort,
  useSetLibraryFacets,
  useSetLibrarySearch,
  useSetLibrarySort,
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

  const [selected, setSelected] = useState<TrackRow | null>(null);
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
        <span className={styles.count}>{t((d) => d.tracks.count, { n: tracks.length })}</span>
      </div>

      <div
        className={styles.body}
        ref={containerRef}
        style={{ "--drawer-width": `${width}px` } as CSSProperties}
      >
        <TrackGrid
          view="table"
          enableFacets
          columns={collectionColumns}
          source={{ kind: "tracks" }}
          sort={sort}
          onSortChange={setSort}
          search={search}
          onSearchChange={setSearch}
          facets={facets}
          onFacetsChange={setFacets}
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
