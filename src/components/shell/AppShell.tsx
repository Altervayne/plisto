// -- Framework Imports --
import { useEffect, useState } from "react";
import type { CSSProperties } from "react";

// -- Component Imports --
import { Sidebar } from "./Sidebar";
import { AlbumGrid } from "../albums/AlbumGrid";
import { AlbumDrawer } from "../albums/AlbumDrawer";
import { FilesView } from "../files/FilesView";
import { EmptyState } from "../common/EmptyState";
import { QuietButton } from "../common/QuietButton";
import { Resizer } from "../common/Resizer/Resizer";
import { SelectionActionBar } from "../organize/SelectionActionBar";

// -- Hook Imports --
import { useDrawerResize } from "../common/Resizer/useDrawerResize";

// -- State Imports --
import { useChangeWorkspace, useScanSummary } from "../../state/store";
import {
  useAlbums,
  useCanRedo,
  useCanUndo,
  useClearError,
  useLoadOrganization,
  useOrgError,
  useRedo,
  useUndo,
} from "../../state/organize/store";
import { useLoadPreferences } from "../../state/preferences/store";

// -- Style Imports --
import styles from "./AppShell.module.css";

/** The library mode showing in the main region: the folder tree or the album wall. */
type Mode = "files" | "albums";

/**
 * The layout root over an indexed workspace: the sidebar and the main region share one continuous
 * ground, parted by space. The sidebar owns the mode switch; the main region shows that mode plus
 * the slim undo/redo controls and the floating action bar. A scan that found no audio is its own
 * terminal state, not an empty shell. The organize projection and the preferences cache hydrate on
 * mount, and Create from anywhere lands on Albums with the new drawer open.
 */
export function AppShell() {
  const summary = useScanSummary();
  const changeWorkspace = useChangeWorkspace();
  const albums = useAlbums();
  const loadOrganization = useLoadOrganization();
  const loadPreferences = useLoadPreferences();
  const undo = useUndo();
  const redo = useRedo();
  const canUndo = useCanUndo();
  const canRedo = useCanRedo();
  const error = useOrgError();
  const clearError = useClearError();
  const [mode, setMode] = useState<Mode>("albums");
  const [selectedAlbumId, setSelectedAlbumId] = useState<number | null>(null);
  const { width, containerRef, resizer } = useDrawerResize();
  const count = summary?.total ?? 0;
  const selectedAlbum = albums.find((a) => a.id === selectedAlbumId) ?? null;

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
        title="No audio files here"
        line="This folder holds no tracks Plisto can read. Try another one."
        action={
          <QuietButton onClick={() => void changeWorkspace()}>Change folder</QuietButton>
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
      />
      <main className={styles.main}>
        <div className={styles.controls}>
          <div className={styles.history}>
            <QuietButton onClick={() => undo()} disabled={!canUndo} aria-label="Undo">
              Undo
            </QuietButton>
            <QuietButton onClick={() => redo()} disabled={!canRedo} aria-label="Redo">
              Redo
            </QuietButton>
          </div>
          {error ? (
            <div className={styles.error} role="status">
              <span>{error}</span>
              <QuietButton onClick={() => clearError()} aria-label="Dismiss">
                Dismiss
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
          ) : (
            <FilesView />
          )}
          <SelectionActionBar
            onCreated={(albumId) => {
              setMode("albums");
              setSelectedAlbumId(albumId);
            }}
          />
        </div>
      </main>
    </div>
  );
}
