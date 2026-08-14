// -- Framework Imports --
import { useEffect, useState } from "react";

// -- Component Imports --
import { AlbumGrid } from "../albums/AlbumGrid";
import { AlbumDrawer } from "../albums/AlbumDrawer";
import { EmptyState } from "../common/EmptyState";
import { QuietButton } from "../common/QuietButton";
import { ViewToggle } from "../common/ViewToggle/ViewToggle";
import { SelectionActionBar } from "../organize/SelectionActionBar";
import { TopBar } from "../topbar/TopBar";
import { ScanSummaryLine } from "../tracks/ScanSummaryLine";
import { TrackDetail } from "../tracks/TrackDetail";
import { TrackGrid } from "../tracks/TrackGrid";

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

// -- Type Imports --
import type { ViewMode } from "../common/ViewToggle/ViewToggle";
import type { TrackRow } from "../../types";

// -- Style Imports --
import styles from "./ResultView.module.css";

/**
 * The view over an indexed workspace: the top area above the content region. A scan that found no
 * audio is its own terminal state, not an empty grid. The view toggle switches between the album
 * grid and the track list; List keeps the read-only detail peek, so the grid narrows rather than
 * being covered. The organize projection hydrates on mount so Grid view has its albums. The action
 * bar floats over the content region whenever tracks are selected, and Create flips back to Grid.
 */
export function ResultView() {
  const summary = useScanSummary();
  const changeWorkspace = useChangeWorkspace();
  const albums = useAlbums();
  const loadOrganization = useLoadOrganization();
  const undo = useUndo();
  const redo = useRedo();
  const canUndo = useCanUndo();
  const canRedo = useCanRedo();
  const error = useOrgError();
  const clearError = useClearError();
  const [selected, setSelected] = useState<TrackRow | null>(null);
  const [view, setView] = useState<ViewMode>("grid");
  const [selectedAlbumId, setSelectedAlbumId] = useState<number | null>(null);
  const count = summary?.total ?? 0;
  const selectedAlbum = albums.find((a) => a.id === selectedAlbumId) ?? null;

  useEffect(() => {
    void loadOrganization();
  }, [loadOrganization]);

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
    <div className={styles.view}>
      <TopBar />
      <div className={styles.controls}>
        <ViewToggle value={view} onChange={setView} />
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
      <div className={styles.content}>
        {view === "grid" ? (
          <>
            <AlbumGrid
              albums={albums}
              selectedAlbumId={selectedAlbumId}
              onOpen={setSelectedAlbumId}
            />
            {selectedAlbum ? (
              <AlbumDrawer album={selectedAlbum} onClose={() => setSelectedAlbumId(null)} />
            ) : null}
          </>
        ) : (
          <>
            <TrackGrid
              summary={summary ? <ScanSummaryLine summary={summary} /> : null}
              selectedId={selected?.id ?? null}
              onSelect={setSelected}
            />
            {selected ? (
              <TrackDetail track={selected} onClose={() => setSelected(null)} />
            ) : null}
          </>
        )}
        <SelectionActionBar onCreated={() => setView("grid")} />
      </div>
    </div>
  );
}
