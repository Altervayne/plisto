// -- Framework Imports --
import { useState } from "react";
import type { CSSProperties } from "react";

// -- Component Imports --
import { TrackGrid } from "../tracks/TrackGrid";
import { TrackDetail } from "../tracks/TrackDetail";
import { EmptyState } from "../common/EmptyState";
import { Resizer } from "../common/Resizer/Resizer";

// -- Hook Imports --
import { useDrawerResize } from "../common/Resizer/useDrawerResize";

// -- State Imports --
import { useUnsortedTracks } from "../../state/organize/store";

// -- i18n Imports --
import { useT } from "../../i18n";

// -- Type Imports --
import type { TrackRow } from "../../types";

// -- Style Imports --
import styles from "./FilesView.module.css";

/**
 * The Unsorted workspace: a flat grid of the loose tracks - those with no album or single membership -
 * with a row peek beside it. No folder tree or breadcrumb; this is the still-to-sort pile, not a place
 * to browse. It shares the store selection and the floating action bar, so Create album and Add to
 * album organize a track straight out of here and the list shrinks toward empty. When nothing is loose
 * the whole library is sorted, so a calm terminal state stands in for the grid.
 */
export function UnsortedView() {
  const unsorted = useUnsortedTracks();
  const [selected, setSelected] = useState<TrackRow | null>(null);
  const { width, containerRef, resizer } = useDrawerResize();
  const t = useT();

  if (unsorted.length === 0) {
    return (
      <EmptyState
        tone="good"
        title={t((d) => d.unsorted.emptyTitle)}
        line={t((d) => d.unsorted.emptyLine)}
      />
    );
  }

  return (
    <div className={styles.view}>
      <div
        className={styles.body}
        ref={containerRef}
        style={{ "--drawer-width": `${width}px` } as CSSProperties}
      >
        <div className={styles.nav}>
          <TrackGrid
            tracks={unsorted}
            selectedId={selected?.id ?? null}
            onSelect={setSelected}
          />
        </div>
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
