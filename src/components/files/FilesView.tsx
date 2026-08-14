// -- Framework Imports --
import { useMemo, useState } from "react";
import type { CSSProperties } from "react";

// -- Component Imports --
import { Breadcrumb } from "./Breadcrumb";
import { FolderBand } from "./FolderBand";
import { LensToggle } from "./LensToggle";
import { TrackGrid } from "../tracks/TrackGrid";
import { TrackDetail } from "../tracks/TrackDetail";
import { Resizer } from "../common/Resizer/Resizer";

// -- Hook Imports --
import { useDrawerResize } from "../common/Resizer/useDrawerResize";
import { useBandResize } from "../common/Resizer/useBandResize";

// -- State Imports --
import { useTracks, useWorkspace } from "../../state/store";
import {
  breadcrumb,
  childFolders,
  descendantTracks,
  foldId,
  immediateTracks,
  parentId,
} from "../../state/files/folderTree";

// -- Type Imports --
import type { Lens } from "./LensToggle";
import type { TrackRow } from "../../types";

// -- Style Imports --
import styles from "./FilesView.module.css";

/**
 * Files mode: folder-hierarchy navigation of the raw scanned files. A breadcrumb and a lens toggle
 * head a nav column that shows the current folder's subfolders over its own tracks (Folders lens) or
 * every file beneath it flat (All-files lens). Drilling changes the scope; the organize selection
 * lives in the store, so it rides across folders untouched. A row peek opens beside the grid.
 */
export function FilesView() {
  const tracks = useTracks();
  const workspace = useWorkspace();
  const rootId = useMemo(() => foldId(workspace ?? ""), [workspace]);

  const [scope, setScope] = useState(rootId);
  const [lens, setLens] = useState<Lens>("folders");
  const [selected, setSelected] = useState<TrackRow | null>(null);
  const { width, containerRef, resizer } = useDrawerResize();
  const band = useBandResize();

  // A new workspace root (a different folder scanned) resets the scope back to it, so the view never
  // strands on a path that no longer exists.
  const [knownRoot, setKnownRoot] = useState(rootId);
  if (knownRoot !== rootId) {
    setKnownRoot(rootId);
    setScope(rootId);
    setSelected(null);
  }

  const crumbs = useMemo(() => breadcrumb(tracks, rootId, scope), [tracks, rootId, scope]);
  const folders = useMemo(() => childFolders(tracks, scope), [tracks, scope]);
  const immediate = useMemo(() => immediateTracks(tracks, scope), [tracks, scope]);
  const descendant = useMemo(() => descendantTracks(tracks, scope), [tracks, scope]);

  // Drilling drops the open peek: the track may not sit in the folder just entered.
  const navigate = (id: string) => {
    setScope(id);
    setSelected(null);
  };

  const scoped = lens === "folders" ? immediate : descendant;

  return (
    <div className={styles.view}>
      <div className={styles.header}>
        <div className={styles.path}>
          <Breadcrumb
            crumbs={crumbs}
            atRoot={scope === rootId}
            onNavigate={navigate}
            onUp={() => navigate(parentId(scope))}
          />
        </div>
        <LensToggle value={lens} onChange={setLens} />
      </div>

      <div
        className={styles.body}
        ref={containerRef}
        style={{ "--drawer-width": `${width}px` } as CSSProperties}
      >
        <div
          className={styles.nav}
          ref={band.containerRef}
          style={{ "--band-height": `${band.height}px` } as CSSProperties}
        >
          {lens === "folders" && folders.length > 0 ? (
            <FolderBand folders={folders} onOpen={navigate} resizer={band.resizer} />
          ) : null}
          <TrackGrid
            tracks={scoped}
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
