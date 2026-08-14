// -- Framework Imports --
import { useEffect, useState } from "react";
import type { CSSProperties } from "react";

// -- Component Imports --
import { Sidebar } from "./Sidebar";
import { AlbumGrid } from "../albums/AlbumGrid";
import { AlbumDrawer } from "../albums/AlbumDrawer";
import { FilesView } from "../files/FilesView";
import { ExportView } from "../export/ExportView";
import { SettingsView } from "../settings/SettingsView";
import { EmptyState } from "../common/EmptyState";
import { QuietButton } from "../common/QuietButton";
import { Resizer } from "../common/Resizer/Resizer";
import { SelectionActionBar } from "../organize/SelectionActionBar";

// -- Hook Imports --
import { useDrawerResize } from "../common/Resizer/useDrawerResize";

// -- State Imports --
import { useAddRoot, useTracks } from "../../state/store";
import {
  useAlbums,
  useCanRedo,
  useCanUndo,
  useClearError,
  useLoadOrganization,
  useOrgError,
  useRedo,
  useSingles,
  useUndo,
} from "../../state/organize/store";
import { useLoadPreferences } from "../../state/preferences/store";

// -- i18n Imports --
import { useT } from "../../i18n";

// -- Style Imports --
import styles from "./AppShell.module.css";

/** The region showing in the main pane: a library wall, the export screen, or settings. */
type Mode = "files" | "albums" | "singles" | "export" | "settings";

/**
 * The layout root over an indexed workspace: the sidebar and the main region share one continuous
 * ground, parted by space. The sidebar owns the mode switch; a library mode shows that wall plus the
 * slim undo/redo controls and the floating action bar, while Export and Settings own the whole region
 * and drop both (they are library chrome). A scan that found no audio is its own terminal state, not an empty
 * shell. The organize projection and the preferences cache hydrate on mount, and Create from anywhere
 * lands on Albums with the new drawer open.
 */
export function AppShell() {
  const tracks = useTracks();
  const addRoot = useAddRoot();
  const albums = useAlbums();
  const singles = useSingles();
  const loadOrganization = useLoadOrganization();
  const loadPreferences = useLoadPreferences();
  const undo = useUndo();
  const redo = useRedo();
  const canUndo = useCanUndo();
  const canRedo = useCanRedo();
  const error = useOrgError();
  const clearError = useClearError();
  const t = useT();
  const [mode, setMode] = useState<Mode>("albums");
  const [selectedAlbumId, setSelectedAlbumId] = useState<number | null>(null);
  const { width, containerRef, resizer } = useDrawerResize();
  // The library's own track count gates content-vs-empty and feeds the Files nav - it holds on boot
  // hydration (no fresh scan summary) as well as after a scan.
  const count = tracks.length;
  // One selection id serves both walls; each mode resolves it against its own bucket, so a stale id from
  // the other wall never opens a drawer here.
  const selectedAlbum = albums.find((a) => a.id === selectedAlbumId) ?? null;
  const selectedSingle = singles.find((a) => a.id === selectedAlbumId) ?? null;

  useEffect(() => {
    void loadOrganization();
    void loadPreferences();
  }, [loadOrganization, loadPreferences]);

  // Global undo/redo, but only when focus is not in a field - a field keeps its own text undo.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (!(e.ctrlKey || e.metaKey)) return;
      const el = document.activeElement;
      const inField =
        el instanceof HTMLElement &&
        (el.tagName === "INPUT" || el.tagName === "TEXTAREA" || el.isContentEditable);
      if (inField) return;
      const key = e.key.toLowerCase();
      if (key === "z" && !e.shiftKey) {
        e.preventDefault();
        undo();
      } else if ((key === "z" && e.shiftKey) || key === "y") {
        e.preventDefault();
        redo();
      }
    };
    window.addEventListener("keydown", onKey);
    return () => window.removeEventListener("keydown", onKey);
  }, [undo, redo]);

  if (count === 0) {
    return (
      <EmptyState
        tone="warn"
        title={t((d) => d.scan.emptyTitle)}
        line={t((d) => d.scan.emptyLine)}
        action={
          <QuietButton onClick={() => void addRoot()}>
            {t((d) => d.settings.addFolder)}
          </QuietButton>
        }
      />
    );
  }

  return (
    <div className={styles.shell}>
      <Sidebar
        mode={mode}
        onModeChange={setMode}
        filesCount={count}
        albumsCount={albums.length}
        singlesCount={singles.length}
      />
      <main className={styles.main}>
        {mode === "export" ? (
          <ExportView />
        ) : mode === "settings" ? (
          <SettingsView />
        ) : (
          <>
            <div className={styles.controls}>
              <div className={styles.history}>
                <QuietButton
                  onClick={() => undo()}
                  disabled={!canUndo}
                  aria-label={t((d) => d.common.undo)}
                >
                  {t((d) => d.common.undo)}
                </QuietButton>
                <QuietButton
                  onClick={() => redo()}
                  disabled={!canRedo}
                  aria-label={t((d) => d.common.redo)}
                >
                  {t((d) => d.common.redo)}
                </QuietButton>
              </div>
              {error ? (
                <div className={styles.error} role="status">
                  <span>{error}</span>
                  <QuietButton onClick={() => clearError()} aria-label={t((d) => d.common.dismiss)}>
                    {t((d) => d.common.dismiss)}
                  </QuietButton>
                </div>
              ) : null}
            </div>
            <div
              className={styles.content}
              ref={containerRef}
              style={{ "--drawer-width": `${width}px` } as CSSProperties}
            >
              {mode === "albums" ? (
                <>
                  <AlbumGrid
                    albums={albums}
                    selectedAlbumId={selectedAlbumId}
                    onOpen={setSelectedAlbumId}
                  />
                  {selectedAlbum ? (
                    <div className={styles.panel}>
                      <Resizer resizer={resizer} />
                      <AlbumDrawer
                        album={selectedAlbum}
                        onClose={() => setSelectedAlbumId(null)}
                      />
                    </div>
                  ) : null}
                </>
              ) : mode === "singles" ? (
                <>
                  <AlbumGrid
                    albums={singles}
                    selectedAlbumId={selectedAlbumId}
                    onOpen={setSelectedAlbumId}
                    emptyTitle={t((d) => d.singles.emptyTitle)}
                    emptyLine={t((d) => d.singles.emptyLine)}
                  />
                  {selectedSingle ? (
                    <div className={styles.panel}>
                      <Resizer resizer={resizer} />
                      <AlbumDrawer
                        album={selectedSingle}
                        onClose={() => setSelectedAlbumId(null)}
                      />
                    </div>
                  ) : null}
                </>
              ) : (
                <FilesView />
              )}
              <SelectionActionBar
                onCreated={(albumId) => {
                  setMode("albums");
                  setSelectedAlbumId(albumId);
                }}
                onMadeSingles={(ids) => {
                  setMode("singles");
                  // One promoted track lands with its editor open; a batch just lands on the wall.
                  setSelectedAlbumId(ids.length === 1 ? ids[0] : null);
                }}
              />
            </div>
          </>
        )}
      </main>
    </div>
  );
}
