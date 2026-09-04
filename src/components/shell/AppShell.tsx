// -- Framework Imports --
import { useCallback, useEffect, useRef, useState } from "react";
import type { CSSProperties } from "react";

// -- Icon Imports --
import { ListPlus } from "lucide-react";

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
import { StandaloneErrorCard } from "../player/StandaloneErrorCard";
import { QueueToast } from "../player/QueueToast";
import { PlayerErrorToast } from "../player/PlayerErrorToast";
import { CoversView } from "../covers/CoversView";
import { ExportView } from "../export/ExportView";
import { SettingsView } from "../settings/SettingsView";
import { SpliceWorkbench } from "../splice/SpliceWorkbench";
import { StaffSpinner } from "../scan/StaffSpinner";
import { EmptyState } from "../common/EmptyState";
import { QuietButton } from "../common/QuietButton";
import { Resizer } from "../common/Resizer/Resizer";
import { SelectionActionBar } from "../organize/SelectionActionBar";

// -- Hook Imports --
import { useDrawerResize } from "../common/Resizer/useDrawerResize";
import { useMountTransition } from "../../hooks/useMountTransition";
import { useFileDrop } from "../../hooks/useFileDrop";

// -- State Imports --
import { useAddRoot, useBoot, useBooted, useRoots, useTracks } from "../../state/store";
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
import {
  useCurrentTrackId,
  usePlayerError,
  usePlayerStore,
  usePlayerSync,
} from "../../state/player/store";
import { useSpectrumSync } from "../../state/player/spectrum";
import { useOpenTool, useSetOpenTool } from "../../state/shell/store";

// -- IPC Imports --
import { getStartupError, playerEnqueueFiles, playerPlayFiles } from "../../lib/ipc";

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

/** The trailing name of a path with its extension dropped, so a refused file reads by its own name. */
function fileStem(path: string): string {
  const leaf = path.split(/[\\/]/).filter(Boolean).pop() ?? path;
  const dot = leaf.lastIndexOf(".");
  return dot > 0 ? leaf.slice(0, dot) : leaf;
}

/**
 * The layout root over an indexed workspace: the sidebar and the main region share one continuous
 * ground, parted by space. The sidebar owns the mode switch; a library mode shows that wall plus the
 * slim undo/redo controls and the floating action bar, while Export and Settings own the whole region
 * and drop both (they are library chrome). A scan that found no audio is its own terminal state, not an empty
 * shell. The organize projection and the preferences cache hydrate on mount, and Create from anywhere
 * lands on Albums with the new drawer open.
 *
 * Standalone mode is the same shell opened on a file the OS handed Plisto: it opens on the Player, owns
 * the library boot itself (the gate never mounts on this path), plays the handed files once, and starts
 * with the sidebar collapsed so the player fills the window. "Open library" slides the sidebar in without
 * remounting - a stocked library stays on the player to navigate from, an empty one lands on onboarding.
 */
export function AppShell({
  standalone = false,
  initialFiles,
  sidebarExpanded = true,
  onOpenLibrary,
}: {
  standalone?: boolean;
  initialFiles?: string[];
  sidebarExpanded?: boolean;
  onOpenLibrary?: () => void;
} = {}) {
  const tracks = useTracks();
  const addRoot = useAddRoot();
  const boot = useBoot();
  const booted = useBooted();
  const roots = useRoots();
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
  // Standalone opens on the Player over the handed file; the full app opens on Albums.
  const [mode, setMode] = useState<Mode>(standalone ? "player" : "albums");
  const [selectedAlbumId, setSelectedAlbumId] = useState<number | null>(null);
  const [openAlbumId, setOpenAlbumId] = useState<number | null>(null);
  const [openPlaylistId, setOpenPlaylistId] = useState<number | null>(null);
  const { width, containerRef, resizer } = useDrawerResize();
  // The library's own track count gates content-vs-empty and feeds the Files nav - it holds on boot
  // hydration (no fresh scan summary) as well as after a scan.
  const count = tracks.length;

  // Standalone's play-once tracking. `failed` latches when the play rejects (every handed file was
  // unreadable); `started` latches the first track that ever held, so a genuine end-of-queue defers to
  // PlayerView's empty state rather than looping back to the pre-first-track load.
  const trackId = useCurrentTrackId();
  const playerNotice = usePlayerError();
  const [failed, setFailed] = useState(false);
  const [started, setStarted] = useState(false);
  // Errored only when nothing plays: the play rejected, or the engine reported a file notice and still
  // holds no track. A survivor playing is never an error, even beside a notice from one file that dropped.
  const playbackErrored =
    standalone && (failed || (trackId == null && playerNotice === "file"));
  // The sidebar collapses only in standalone-not-expanded; the full app is always expanded.
  const collapsed = !sidebarExpanded;
  // The revealed sidebar has no library to list: strip the empty nav groups and keep only the foot, so
  // the opened file plays on through the mini while onboarding shows in the main region.
  const noLibrary = standalone && booted && roots.length === 0;
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

  // The organize and playlist projections hydrate once the library is up. On the normal path the gate has
  // already booted before this shell mounts, so they load on bare mount. Standalone mounts ahead of its
  // own background boot and OWNS it here (the gate never mounts), so those two reads wait for boot to
  // resolve - a bare-mount read would hit an empty DB and leave Albums and Playlists blank even after the
  // tracks hydrate. Preferences carry theme and locale, so they load at once on both paths.
  useEffect(() => {
    if (!standalone) {
      void loadOrganization();
      void loadPlaylists();
      void loadPreferences();
      return;
    }
    let alive = true;
    void loadPreferences();
    void boot().then(() => {
      if (!alive) return;
      void loadOrganization();
      void loadPlaylists();
    });
    return () => {
      alive = false;
    };
  }, [standalone, boot, loadOrganization, loadPlaylists, loadPreferences]);

  // The launch's files play from the backend intake buffer now, not here, so a multi-select that fans out
  // into sibling launches lands in one queue rather than the last file replacing the rest. This only pulls
  // the take-once launch error: an all-unreadable batch latches it, so the refusal body shows even when
  // the batch's file notice fired before this shell subscribed. A batch that plays clears the region to
  // the player as its first track holds.
  useEffect(() => {
    if (!standalone) return;
    void getStartupError()
      .then((notice) => {
        if (notice) setFailed(true);
      })
      .catch(() => {});
  }, [standalone]);

  // A file dropped onto the player, off the desktop: append it to a playing queue, or start fresh when
  // nothing holds. The playing check reads the store directly so the drop handler stays stable and never
  // re-binds the window listener on a track change. The ad-hoc up-next rows name themselves through the
  // queue echo, so no snapshot is passed here.
  const onFilesDropped = useCallback((paths: string[]) => {
    if (usePlayerStore.getState().status.track_id != null) {
      void playerEnqueueFiles(paths).catch(() => {});
    } else {
      void playerPlayFiles(paths).catch(() => {});
    }
  }, []);
  // Scoped to the Player surface: the standalone player, or the full app's Player destination. Off it a
  // file drop is ignored, so it never hijacks the library walls or the cover import slots.
  const dropActive = useFileDrop(mode === "player", onFilesDropped);

  // Latch the first track that ever holds; after it, PlayerView owns the empty state.
  useEffect(() => {
    if (trackId != null) setStarted(true);
  }, [trackId]);

  // The one-way "Open library" reveal, standalone only: an empty library lands the main region on the
  // add-a-folder onboarding, while a stocked one stays on the player for the user to navigate from the
  // now-visible sidebar. Waits for boot so a stocked library is never misread as empty mid-hydration.
  useEffect(() => {
    if (noLibrary && sidebarExpanded) setMode("albums");
  }, [noLibrary, sidebarExpanded]);

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

  // A scanned library with no audio is onboarding to add a folder. On the normal path this is the whole
  // shell's terminal state, unchanged. Standalone never takes this early return - it must keep the player
  // painting (a fresh install, or the window before boot hydrates a stocked one), so it shows the same
  // onboarding per-mode instead, only for a library mode and never over the player.
  const emptyLibrary = (
    <EmptyState
      tone="warn"
      title={t((d) => d.scan.emptyTitle)}
      line={t((d) => d.scan.emptyLine)}
      action={
        <QuietButton onClick={() => void addRoot()}>{t((d) => d.settings.addFolder)}</QuietButton>
      }
    />
  );

  if (!standalone && count === 0) {
    return emptyLibrary;
  }

  return (
    <div className={styles.shell} data-collapsed={collapsed ? "" : undefined}>
      <Sidebar
        mode={mode}
        onModeChange={setMode}
        filesCount={count}
        unsortedCount={unsorted.length}
        albumsCount={albums.length}
        singlesCount={singles.length}
        playlistsCount={playlists.length}
        coversCount={coversNeeded}
        collapsed={collapsed}
        bare={noLibrary && sidebarExpanded}
      />
      <main className={styles.main}>
        {mode === "export" ? (
          <ExportView />
        ) : mode === "player" ? (
          playbackErrored ? (
            // Every handed file was unreadable: the honest refusal body on the player surface, with the
            // same "Open library" escape the title bar carries.
            <StandaloneErrorCard
              stem={fileStem(initialFiles?.[0] ?? "")}
              onOpenLibrary={onOpenLibrary}
            />
          ) : standalone && !started ? (
            // Before the engine holds the first track, the app's loading motion - not PlayerView's idle
            // "nothing playing", which would misread the brief load as an empty player.
            <div className={styles.playerLoad}>
              <StaffSpinner />
            </div>
          ) : (
            <PlayerView onNavigate={onNavigate} />
          )
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
        ) : count === 0 ? (
          // A library wall with no tracks: the add-a-folder onboarding. Only ever reached in standalone
          // (the normal path took the early return above), when "Open library" opened an empty library.
          emptyLibrary
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

        {/* The drop affordance: a soft accent wash over the player region while a file drag hovers, so
            the player reads as a drop target. Scoped to the Player surface by dropActive - a subtle wash,
            not a heavy frame, to keep the continuous-surface look. */}
        {dropActive ? (
          <div className={styles.dropVeil} aria-hidden="true">
            <div className={styles.dropHint}>
              <ListPlus size={20} strokeWidth={1.75} />
              <span>{t((d) => d.player.dropToQueue)}</span>
            </div>
          </div>
        ) : null}

        {/* The added-to-queue nudge, over everything: a menu append from any surface lands here. */}
        <QueueToast />

        {/* The playback-failure nudge, on the same pill: a file that could not be read lands here. The
            standalone all-fail case shows the refusal body instead and suppresses the toast, so the same
            file notice never doubles - and leaving it mounted would clear the notice and unlatch the body. */}
        {playbackErrored ? null : <PlayerErrorToast />}
      </main>
    </div>
  );
}
