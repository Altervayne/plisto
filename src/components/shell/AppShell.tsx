// -- Framework Imports --
import { Fragment, useCallback } from "react";
import type { CSSProperties } from "react";

// -- Icon Imports --
import { ListPlus } from "lucide-react";

// -- Component Imports --
import { Sidebar } from "./Sidebar";
import { HomeView } from "../home/HomeView";
import { CollectionView } from "../collection/CollectionView";
import { CollectionSwitch } from "../collection/CollectionSwitch";
import { FilesView } from "../files/FilesView";
import { HistoryView } from "../tracks/HistoryView";
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
import { SelectionActionBar } from "../organize/SelectionActionBar";
import { Finder } from "../finder/Finder";
import { DuplicatesHost } from "../duplicates/DuplicatesHost";
import { GoneHost } from "../gone/GoneHost";
import { ScanIssuesHost } from "../scan/ScanIssuesHost";
import { FileWritesHost } from "../fileWrites/FileWritesHost";
import { ShortcutsSheet } from "../shortcuts/ShortcutsSheet";
import { PluginPage } from "../plugins/PluginPage";
import { PluginFrameLayer } from "../plugins/frames/PluginFrameLayer";
import { PluginToast } from "../plugins/PluginToast";
import { PluginConfirmHost } from "../plugins/PluginConfirmHost";
import { PluginNoticeHost } from "../plugins/PluginNoticeHost";
import { SafeModeOffer } from "../plugins/SafeModeOffer";
import { SafeModeBanner } from "../plugins/SafeModeBanner";

// -- Hook Imports --
import { useDrawerResize } from "../common/Resizer/useDrawerResize";
import { useFileDrop } from "../../hooks/useFileDrop";
import { useShellShortcuts } from "./useShellShortcuts";
import { useCollectionSegment } from "../collection/useCollectionSegment";
import { useFinderLaunch } from "./useFinderLaunch";
import { useShellSync } from "./useShellSync";
import { useShellBoot } from "./useShellBoot";
import { useShellNavigation } from "./useShellNavigation";
import { useStandalonePlayback } from "./useStandalonePlayback";

// -- State Imports --
import {
  useAddRoot,
  useBooted,
  useRoots,
  useSetLibraryGone,
  useTracks,
} from "../../state/store";
import {
  useAlbums,
  useCanRedo,
  useCanUndo,
  useClearError,
  useOrgError,
  useRedo,
  useSingles,
  useUndo,
  useUnsortedTracks,
} from "../../state/organize/store";
import { usePlaylists } from "../../state/playlists/store";
import { useOrgStatus, usePlaylistsStatus } from "../../state/projectionStatus";
import { useNeedsCoverCount } from "../../state/covers/store";
import { useCloseCollectionFull, useCollectionFullAlbumId } from "../../state/collection/store";
import { useAppMode, usePlayerStore } from "../../state/player/store";
import { useStageNets } from "../../state/player/pluginVis/useStageNets";
import { useKindThumbs } from "../../state/player/pluginVis/useKindThumbs";
import { useRestoreGeneration } from "../../state/restorePoints/store";
import { useHistoryLens, useSetShortcutsOpen, useShortcutsOpen } from "../../state/shell/store";

// -- IPC Imports --
import { playerEnqueueFiles, playerPlayFiles } from "../../lib/ipc";

// -- Unit Imports --
import { visibleSegments } from "../collection/collectionSegments";

// -- Type Imports --
import type { FinderNav } from "../finder/useFinderActions";

// -- i18n Imports --
import { useT } from "../../i18n";

// -- Style Imports --
import styles from "./AppShell.module.css";

/** The trailing name of a path with its extension dropped, so a refused file reads by its own name. */
function fileStem(path: string): string {
  const leaf = path.split(/[\\/]/).filter(Boolean).pop() ?? path;
  const dot = leaf.lastIndexOf(".");
  return dot > 0 ? leaf.slice(0, dot) : leaf;
}

/**
 * The layout root over an indexed workspace: the sidebar and the main region share one continuous
 * ground. The sidebar owns the mode switch; a library mode shows its view plus the undo/redo controls
 * and the action bar, while Export and Settings own the whole region. Every route goes through
 * `navigate`, so a jump into the Collection always names its segment. A scan that found no audio is its
 * own terminal state. The organize projection and preferences hydrate on mount.
 *
 * Standalone mode is the same shell opened on a file the OS handed Plisto: it opens on the Player, owns
 * the library boot itself, plays the handed files once, and starts with the sidebar collapsed. "Open
 * library" slides the sidebar in without remounting.
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
  const booted = useBooted();
  const roots = useRoots();
  const setLibraryGone = useSetLibraryGone();
  const albums = useAlbums();
  const singles = useSingles();
  const unsorted = useUnsortedTracks();
  const playlists = usePlaylists();
  const orgReady = useOrgStatus() === "ready";
  const playlistsReady = usePlaylistsStatus() === "ready";
  const coversNeeded = useNeedsCoverCount();
  const undo = useUndo();
  const redo = useRedo();
  const canUndo = useCanUndo();
  const canRedo = useCanRedo();
  const error = useOrgError();
  const clearError = useClearError();
  const t = useT();
  useShellSync();
  useStageNets();
  useKindThumbs();
  const appMode = useAppMode();
  // The library's own track count gates content-vs-empty and feeds the Files nav - it holds on boot
  // hydration (no fresh scan summary) as well as after a scan.
  const count = tracks.length;
  // The sidebar collapses only in standalone-not-expanded; the full app is always expanded.
  const collapsed = !sidebarExpanded;
  // The revealed sidebar has no library to list: strip the empty nav groups and keep only the foot, so
  // the opened file plays on through the mini while onboarding shows in the main region.
  const noLibrary = standalone && booted && roots.length === 0;
  useShellBoot(standalone);
  const {
    mode,
    setMode,
    navigate,
    onNavigate,
    openPlugin,
    pluginId,
    pluginLive,
    openPlaylistId,
    setOpenPlaylistId,
    openTool,
    closeTool,
  } = useShellNavigation({ standalone, sidebarExpanded, noLibrary });
  const segment = useCollectionSegment();
  const fullAlbumId = useCollectionFullAlbumId();
  const closeFull = useCloseCollectionFull();
  const { width, containerRef, resizer } = useDrawerResize();
  const { playbackErrored, started } = useStandalonePlayback(standalone);
  // The album full pane covers the wall only on the Albums segment; a deleted id never counts as open.
  const fullPaneShowing =
    mode === "collection" &&
    segment === "albums" &&
    fullAlbumId != null &&
    albums.some((a) => a.id === fullAlbumId);
  // The full-pane playlist, scoped like the album pane: a deleted id no longer resolves, so the pane
  // falls back to the list rather than stranding on it.
  const openPlaylist = playlists.find((p) => p.id === openPlaylistId) ?? null;
  // An unloaded list holds no playlist, so only a loaded one can call the id gone.
  if (playlistsReady && openPlaylistId != null && openPlaylist == null) {
    setOpenPlaylistId(null);
  }

  // The lens the History destination opens on. A Home See-all sets it before navigating, so History
  // seeds its own local lens from it on mount.
  const historyLens = useHistoryLens();
  // A restore reassigns album and playlist ids, so the library destinations remount and drop every id
  // their local state held (selections, open rows, dialogs). Settings keeps its result sheet.
  const restoreGeneration = useRestoreGeneration();

  // A file dropped onto the player, off the desktop: append to a playing queue, or start fresh. The
  // playing check reads the store directly so the drop handler stays stable and never re-binds the
  // listener on a track change.
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

  const finder = useFinderLaunch({ tracks: count, standalone, sidebarExpanded });

  // The app-wide keys. Escape backs out of the full pane showing on its own destination. The album grid
  // stays mounted under its pane, so its select-all is off while the pane covers it.
  const shortcutsOpen = useShortcutsOpen();
  const setShortcutsOpen = useSetShortcutsOpen();
  const paneBack = fullPaneShowing
    ? closeFull
    : mode === "playlists" && openPlaylist != null
      ? () => setOpenPlaylistId(null)
      : null;
  useShellShortcuts({
    finderEnabled: finder.enabled,
    openFinder: finder.openFromKeys,
    undo,
    redo,
    onBack: paneBack,
    editorSession: mode === "editor" && openTool != null,
    viewKeysLive: !fullPaneShowing,
    playerEnabled: appMode !== "organizer",
    openShortcuts: () => setShortcutsOpen(true),
  });
  const closeShortcuts = useCallback(() => setShortcutsOpen(false), [setShortcutsOpen]);

  // The finder's jumps, mirroring the routes the walls and the Player's "playing from" link take.
  const finderNav: FinderNav = {
    go: navigate,
    openAlbum: (albumId) => navigate({ segment: "albums", full: albumId }),
    openSingle: (albumId) => navigate({ segment: "singles", drawer: albumId }),
    openPlaylist: (playlistId) => {
      setOpenPlaylistId(playlistId);
      setMode("playlists");
    },
    openPlugin,
  };

  // A scanned library with no audio is onboarding to add a folder. On the normal path this is the shell's
  // terminal state. Standalone never takes this early return - it keeps the player painting and shows the
  // same onboarding per-mode instead, only for a library mode and never over the player.
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
        onOpenPlugin={openPlugin}
        filesCount={count}
        unsortedCount={orgReady ? unsorted.length : undefined}
        playlistsCount={playlistsReady ? playlists.length : undefined}
        coversCount={coversNeeded}
        collapsed={collapsed}
        bare={noLibrary && sidebarExpanded}
        search={finder.pill}
      />
      <main className={styles.main}>
        <SafeModeBanner />
        {mode === "home" ? (
          // Home needs a library; an empty one keeps the add-a-folder onboarding, as the walls do.
          count === 0 ? emptyLibrary : <HomeView key={restoreGeneration} onNavigate={navigate} />
        ) : mode === "export" ? (
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
            <PlayerView onNavigate={onNavigate} compact={standalone && !sidebarExpanded} />
          )
        ) : mode === "settings" ? (
          <SettingsView
            onSearchSettings={finder.enabled ? (door) => finder.openScoped(door, "settings") : undefined}
          />
        ) : pluginId != null ? (
          pluginLive ? <PluginPage id={pluginId} /> : null
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
          <CoversView key={restoreGeneration} />
        ) : mode === "playlists" ? (
          openPlaylist ? (
            <PlaylistView
              key={restoreGeneration}
              playlistId={openPlaylist.id}
              onBack={() => setOpenPlaylistId(null)}
              onOpenAlbum={(albumId) => navigate({ segment: "albums", full: albumId })}
            />
          ) : (
            <PlaylistsView key={restoreGeneration} onOpen={setOpenPlaylistId} />
          )
        ) : mode === "history" ? (
          <HistoryView key={restoreGeneration} initialLens={historyLens} />
        ) : count === 0 ? (
          // A library wall with no tracks: the add-a-folder onboarding. Only ever reached in standalone
          // (the normal path took the early return above), when "Open library" opened an empty library.
          emptyLibrary
        ) : (
          <Fragment key={restoreGeneration}>
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
              {mode === "collection" ? (
                <CollectionSwitch
                  visible={visibleSegments(appMode)}
                  segment={segment}
                  counts={{
                    albums: orgReady ? albums.length : undefined,
                    singles: orgReady ? singles.length : undefined,
                    tracks: count,
                  }}
                  onChange={(next) => navigate({ segment: next })}
                />
              ) : null}
            </div>
            <div
              className={styles.content}
              ref={containerRef}
              style={{ "--drawer-width": `${width}px` } as CSSProperties}
            >
              {mode === "collection" ? (
                <CollectionView
                  segment={segment}
                  albums={albums}
                  singles={singles}
                  resizer={resizer}
                />
              ) : mode === "unsorted" ? (
                <UnsortedView onShowAlbums={() => navigate({ segment: "albums" })} />
              ) : (
                <FilesView />
              )}
              <SelectionActionBar
                onCreated={(albumId) => navigate({ segment: "albums", drawer: albumId })}
                // One promoted track lands with its editor open; a batch just lands on the wall.
                onMadeSingles={(ids) =>
                  navigate({ segment: "singles", drawer: ids.length === 1 ? ids[0] : null })
                }
              />
            </div>
          </Fragment>
        )}

        {/* Every plugin frame lives in this layer, over the plugin page's slot. */}
        <PluginFrameLayer pageId={pluginLive ? pluginId : null} />

        {/* The Track Editor's workbench. It stays mounted while a session holds, so navigating off and
            back keeps the in-progress edit whole. Off the destination it is hidden, not torn down;
            `active` follows that visibility so the library pauses on entry and restores on leave. Keyed
            on the session so a different file is a fresh mount. */}
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

        {/* The plugin toast joins the same foot stack, above Plisto's own pills. */}
        <PluginToast />

        {/* Plisto's own notice about a plugin it turned off, on the common pill. */}
        <PluginNoticeHost />

        {/* The playback-failure nudge, on the same pill: a file that could not be read lands here. The
            standalone all-fail case shows the refusal body instead and suppresses the toast, so the same
            file notice never doubles - and leaving it mounted would clear the notice and unlatch the body. */}
        {playbackErrored ? null : <PlayerErrorToast />}

        {finder.finder ? <Finder nav={finderNav} {...finder.finder} /> : null}
        <DuplicatesHost />
        <GoneHost
          onShowAll={() => {
            setLibraryGone(true);
            navigate({ segment: "tracks" });
          }}
        />
        <ScanIssuesHost />
        <FileWritesHost />
        <PluginConfirmHost />

        {/* The offer to start without plugins, shown while the runtime is held after an unclean exit. */}
        <SafeModeOffer />

        {shortcutsOpen ? <ShortcutsSheet onClose={closeShortcuts} /> : null}
      </main>
    </div>
  );
}
