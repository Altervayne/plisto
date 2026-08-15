// -- Framework Imports --
import { useMemo, useState } from "react";
import type { CSSProperties, ReactNode } from "react";

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
import { useRoots } from "../../state/store";
import {
  childFolders,
  descendantTracks,
  foldId,
  immediateTracks,
  isLibraryScope,
  LIBRARY_SCOPE,
  libraryBreadcrumb,
  parentId,
  rootFolders,
} from "../../state/files/folderTree";

// -- i18n Imports --
import { useT } from "../../i18n";

// -- Type Imports --
import type { Lens } from "./LensToggle";
import type { TrackRow } from "../../types";

// -- Style Imports --
import styles from "./LibraryBrowser.module.css";

/**
 * Folder-hierarchy navigation over a set of tracks. A breadcrumb and a lens toggle head a nav column
 * that shows the current folder's subfolders over its own tracks (Folders lens) or every file beneath
 * it flat (All-files lens). Drilling changes the scope; the organize selection lives in the store, so
 * it rides across folders untouched. A row peek opens beside the grid. The tree, breadcrumb, and folder
 * band all derive from the passed tracks, so feeding a subset scopes the whole browser to it - folders
 * with no track in the subset simply drop out. An empty set with an emptyState shows that in place of
 * the browser; without one it falls through to the quiet empty grid.
 */
export function LibraryBrowser({
  tracks,
  emptyState,
}: {
  tracks: TrackRow[];
  emptyState?: ReactNode;
}) {
  const roots = useRoots();
  const t = useT();

  // One root anchors the tree at that folder; several anchor at the library level above them all.
  const initialScope = useMemo(
    () => (roots.length > 1 ? LIBRARY_SCOPE : foldId(roots[0]?.path ?? "")),
    [roots],
  );
  // A fold-stable signature of the root set, so an add or remove resets the scope below.
  const rootsKey = useMemo(() => roots.map((r) => foldId(r.path)).join("|"), [roots]);

  const [scope, setScope] = useState(initialScope);
  const [lens, setLens] = useState<Lens>("folders");
  const [selected, setSelected] = useState<TrackRow | null>(null);
  const { width, containerRef, resizer } = useDrawerResize();
  const band = useBandResize();

  // A changed root set (a folder added or removed) resets the scope to its anchor, so the view
  // never strands on a path that no longer exists.
  const [knownRoots, setKnownRoots] = useState(rootsKey);
  if (knownRoots !== rootsKey) {
    setKnownRoots(rootsKey);
    setScope(initialScope);
    setSelected(null);
  }

  const atLibrary = isLibraryScope(scope);
  const libraryName = t((d) => d.files.library);

  const crumbs = useMemo(
    () => libraryBreadcrumb(tracks, roots, scope, libraryName),
    [tracks, roots, scope, libraryName],
  );
  // At the library level the rows are the roots; below it the scope's subfolders. No immediate
  // tracks sit at the library level, so its grid stays quietly empty in the Folders lens.
  const folders = useMemo(
    () => (atLibrary ? rootFolders(tracks, roots) : childFolders(tracks, scope)),
    [atLibrary, tracks, roots, scope],
  );
  const immediate = useMemo(
    () => (atLibrary ? [] : immediateTracks(tracks, scope)),
    [atLibrary, tracks, scope],
  );
  const descendant = useMemo(
    () => (atLibrary ? tracks : descendantTracks(tracks, scope)),
    [atLibrary, tracks, scope],
  );

  // Drilling drops the open peek: the track may not sit in the folder just entered.
  const navigate = (id: string) => {
    setScope(id);
    setSelected(null);
  };

  // Up from a root returns to the library; from a subfolder it climbs one folder as usual.
  const scopeIsRoot = roots.some((r) => foldId(r.path) === scope);
  const onUp = () =>
    navigate(roots.length > 1 && scopeIsRoot ? LIBRARY_SCOPE : parentId(scope));

  const scoped = lens === "folders" ? immediate : descendant;

  // Nothing to browse: an empty set stands in for the whole browser when a terminal state is given.
  if (tracks.length === 0 && emptyState != null) {
    return <>{emptyState}</>;
  }

  return (
    <div className={styles.view}>
      <div className={styles.header}>
        <div className={styles.path}>
          <Breadcrumb
            crumbs={crumbs}
            atRoot={scope === initialScope}
            onNavigate={navigate}
            onUp={onUp}
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
