// -- Framework Imports --
import { useCallback, useEffect, useRef, useState } from "react";
import type { CSSProperties } from "react";

// -- Component Imports --
import { Sidebar } from "./Sidebar";
import { AlbumGrid } from "../albums/AlbumGrid";
import { AlbumDrawer } from "../albums/AlbumDrawer";
import { AlbumFolderView } from "../albums/AlbumFolderView";
import { FilesView } from "../files/FilesView";
import { UnsortedView } from "../files/UnsortedView";
import { PlaylistsView } from "../playlists/PlaylistsView";
import { PlaylistView } from "../playlists/PlaylistView";
import { PlayerView } from "../player/PlayerView";
import { CoversView } from "../covers/CoversView";
import { ExportView } from "../export/ExportView";
import { SettingsView } from "../settings/SettingsView";
import { SpliceWorkbench } from "../splice/SpliceWorkbench";
import { EmptyState } from "../common/EmptyState";
import { QuietButton } from "../common/QuietButton";
import { Resizer } from "../common/Resizer/Resizer";
import { SelectionActionBar } from "../organize/SelectionActionBar";

// -- Hook Imports --
import { useDrawerResize } from "../common/Resizer/useDrawerResize";
import { useMountTransition } from "../../hooks/useMountTransition";

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
  useUnsortedTracks,
} from "../../state/organize/store";
import { useLoadPlaylists, usePlaylists } from "../../state/playlists/store";
import { useNeedsCoverCount } from "../../state/covers/store";
import { useLoadPreferences } from "../../state/preferences/store";
import { usePlayerSync } from "../../state/player/store";
import { useSpectrumSync } from "../../state/player/spectrum";
import { useOpenTool, useSetOpenTool } from "../../state/shell/store";

// -- Type Imports --
import type { AlbumRow, PlaybackSource } from "../../types";

// -- i18n Imports --
import { useT } from "../../i18n";

// -- Style Imports --
import styles from "./AppShell.module.css";

/** The region showing in the main pane: a library wall, the export screen, or settings. */
type Mode =
  | "files"
  | "unsorted"
  | "albums"
  | "singles"
  | "playlists"
  | "covers"
  | "editor"
  | "player"
  | "export"
  | "settings";

/** The drawer content's exit before the panel unmounts, matching --dur-soft on the exit keyframe. */
const DRAWER_EXIT_MS = 200;

/** The full pane's fade-out before it unmounts, matching --dur-fast on the exit keyframe. */
const VIEW_EXIT_MS = 120;

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
  const unsorted = useUnsortedTracks();
  const playlists = usePlaylists();
  const coversNeeded = useNeedsCoverCount();
  const loadOrganization = useLoadOrganization();
  const loadPlaylists = useLoadPlaylists();
  const loadPreferences = useLoadPreferences();
  const undo = useUndo();
  const redo = useRedo();
  const canUndo = useCanUndo();
  const canRedo = useCanRedo();
  const error = useOrgError();
  const clearError = useClearError();
  const t = useT();
  // One listener for the app's life, following the engine's status and error events into the store.
  usePlayerSync();
  // The live spectrum feed into its own off-render singleton, running the app's life alongside the status.
  useSpectrumSync();
  const [mode, setMode] = useState<Mode>("albums");
  const [selectedAlbumId, setSelectedAlbumId] = useState<number | null>(null);
  const [openAlbumId, setOpenAlbumId] = useState<number | null>(null);
  const [openPlaylistId, setOpenPlaylistId] = useState<number | null>(null);
  const { width, containerRef, resizer } = useDrawerResize();
  // The library's own track count gates content-vs-empty and feeds the Files nav - it holds on boot
  // hydration (no fresh scan summary) as well as after a scan.
  const count = tracks.length;
  // One selection id serves both walls; each mode resolves it against its own bucket, so a stale id from
  // the other wall never opens a drawer here.
  const selectedAlbum = albums.find((a) => a.id === selectedAlbumId) ?? null;
  const selectedSingle = singles.find((a) => a.id === selectedAlbumId) ?? null;
  // The full-pane album, scoped to albums alone. A deleted id no longer resolves, so the pane falls
  // back to the grid rather than stranding on it.
  const openAlbum = albums.find((a) => a.id === openAlbumId) ?? null;
  if (openAlbumId != null && openAlbum == null) {
    setOpenAlbumId(null);
  }
  // The full-pane playlist, scoped like the album pane: a deleted id no longer resolves, so the pane
  // falls back to the list rather than stranding on it.
  const openPlaylist = playlists.find((p) => p.id === openPlaylistId) ?? null;
  if (openPlaylistId != null && openPlaylist == null) {
    setOpenPlaylistId(null);
  }

  // Hold each drawer through its exit after the selection clears. The panel width snaps; only the
  // drawer content transform-fades. The selection is already null by then, so a ref keeps the last
  // album to render during the fade rather than showing an empty panel.
  const albumDrawer = useMountTransition(selectedAlbum != null, DRAWER_EXIT_MS);
  const lastAlbum = useRef<AlbumRow | null>(null);
  if (selectedAlbum) lastAlbum.current = selectedAlbum;
  const singleDrawer = useMountTransition(selectedSingle != null, DRAWER_EXIT_MS);
  const lastSingle = useRef<AlbumRow | null>(null);
  if (selectedSingle) lastSingle.current = selectedSingle;

  // Hold the full pane through its fade-out, retaining the last album so it renders during the exit
  // once its id has cleared.
  const fullPane = useMountTransition(openAlbum != null, VIEW_EXIT_MS);
  const lastOpenAlbum = useRef<AlbumRow | null>(null);
  if (openAlbum) lastOpenAlbum.current = openAlbum;

  // The Track Editor destination's session. Opening a tool lands on that destination and the session
  // persists across nav: the workbench stays mounted while a session holds, hidden off the destination.
  // Closing the session clears it and leaves the empty state showing on the destination.
  const openTool = useOpenTool();
  const setOpenTool = useSetOpenTool();
  const closeTool = useCallback(() => setOpenTool(null), [setOpenTool]);

  // Entering the full pane closes the drawer: the two album surfaces never show at once. Stable across
  // renders so the memoized cards never re-render on its account.
  const openFull = useCallback((albumId: number) => {
    setOpenAlbumId(albumId);
    setSelectedAlbumId(null);
  }, []);

  // Routes the Player's "playing from" link back into the library: a container opens its full pane, a flat
  // view just switches mode. A lone single carries a track id, not a container, so it has no destination.
  const onNavigate = useCallback((source: PlaybackSource) => {
    switch (source.kind) {
      case "album":
        setOpenAlbumId(source.id);
        setMode("albums");
        break;
      case "playlist":
        setOpenPlaylistId(source.id);
        setMode("playlists");
        break;
      case "files":
        setMode("files");
        break;
      case "singles":
        setMode("singles");
        break;
      case "unsorted":
        setMode("unsorted");
        break;
      case "single":
        break;
    }
  }, []);

  useEffect(() => {
    void loadOrganization();
    void loadPlaylists();
    void loadPreferences();
  }, [loadOrganization, loadPlaylists, loadPreferences]);

  // Opening a tool from a track's menu lands on the Editor destination. Clearing the session does not
  // navigate: closing a file leaves you on the destination, showing its empty state.
  useEffect(() => {
    if (openTool != null) setMode("editor");
  }, [openTool]);

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
        unsortedCount={unsorted.length}
        albumsCount={albums.length}
        singlesCount={singles.length}
        playlistsCount={playlists.length}
        coversCount={coversNeeded}
      />
      <main className={styles.main}>
        {mode === "export" ? (
          <ExportView />
        ) : mode === "player" ? (
          <PlayerView onNavigate={onNavigate} />
        ) : mode === "settings" ? (
          <SettingsView />
        ) : mode === "editor" ? (
          // The workbench layer covers this while a session holds; the prompt shows only when idle.
          openTool ? null : (
            <EmptyState
              tone="idle"
              title={t((d) => d.splice.editorTitle)}
              line={t((d) => d.splice.editorHint)}
            />
          )
        ) : mode === "covers" ? (
          <CoversView />
        ) : mode === "playlists" ? (
          openPlaylist ? (
            <PlaylistView
              playlistId={openPlaylist.id}
              onBack={() => setOpenPlaylistId(null)}
            />
          ) : (
            <PlaylistsView onOpen={setOpenPlaylistId} />
          )
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
                  {/* The grid holds the flow and fades under the full pane; the pane overlays it and
                      crossfades in, so neither large view reflows the other. `inert` while it is under
                      keeps keyboard focus out of the hidden cards, which opacity + pointer-events alone
                      would still leave in the tab order. */}
                  <div
                    className={styles.gridLayer}
                    data-under={openAlbum != null ? "" : undefined}
                    inert={openAlbum != null || undefined}
                  >
                    <AlbumGrid
                      albums={albums}
                      selectedAlbumId={selectedAlbumId}
                      onOpen={setSelectedAlbumId}
                      onOpenFull={openFull}
                    />
                    {albumDrawer.mounted && lastAlbum.current ? (
                      <div className={styles.panel}>
                        <Resizer resizer={resizer} />
                        <AlbumDrawer
                          album={lastAlbum.current}
                          state={albumDrawer.state}
                          onClose={() => setSelectedAlbumId(null)}
                          onOpenFull={openFull}
                        />
                      </div>
                    ) : null}
                  </div>
                  {/* Mount the pane the same render the grid starts dimming, not a frame later: keying
                      render on the live id (plus the exit hold) closes the gap where the grid showed
                      undimmed with no overlay. data-state rides the live id too, so enter plays at once. */}
                  {(openAlbum != null || fullPane.mounted) && lastOpenAlbum.current ? (
                    <div
                      className={styles.fullLayer}
                      data-state={openAlbum != null ? "enter" : "exit"}
                    >
                      <AlbumFolderView
                        album={openAlbum ?? lastOpenAlbum.current}
                        onBack={() => setOpenAlbumId(null)}
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
                  {singleDrawer.mounted && lastSingle.current ? (
                    <div className={styles.panel}>
                      <Resizer resizer={resizer} />
                      <AlbumDrawer
                        album={lastSingle.current}
                        state={singleDrawer.state}
                        onClose={() => setSelectedAlbumId(null)}
                      />
                    </div>
                  ) : null}
                </>
              ) : mode === "unsorted" ? (
                <UnsortedView />
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

        {/* The Track Editor's workbench. It stays mounted while a session holds, so navigating off the
            destination and back keeps the in-progress edit whole rather than re-analyzing. Off the
            destination it is hidden, not torn down; `active` follows that visibility so the library
            pauses on entry and restores on leave. Keyed on the session so opening a different file is a
            fresh mount, resetting the analysis and phase. */}
        {openTool != null ? (
          <div
            key={`${openTool.verb}:${openTool.trackId}`}
            className={styles.toolLayer}
            hidden={mode !== "editor"}
          >
            <SpliceWorkbench
              verb={openTool.verb}
              trackId={openTool.trackId}
              active={mode === "editor"}
              onClose={closeTool}
            />
          </div>
        ) : null}
      </main>
    </div>
  );
}
