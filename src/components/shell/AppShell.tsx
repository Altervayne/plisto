// -- Framework Imports --
import { useCallback, useEffect, useRef, useState } from "react";
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
import { ScanIssuesHost } from "../scan/ScanIssuesHost";
import { ShortcutsSheet } from "../shortcuts/ShortcutsSheet";
import { PluginPage } from "../plugins/PluginPage";
import { PluginFrameLayer } from "../plugins/frames/PluginFrameLayer";
import { PluginToast } from "../plugins/PluginToast";
import { PluginConfirmHost } from "../plugins/PluginConfirmHost";
import { PluginNoticeHost } from "../plugins/PluginNoticeHost";
import { SafeModeOffer } from "../plugins/SafeModeOffer";

// -- Hook Imports --
import { useDrawerResize } from "../common/Resizer/useDrawerResize";
import { useFileDrop } from "../../hooks/useFileDrop";
import { useShellShortcuts } from "./useShellShortcuts";
import { useCollectionSegment } from "../collection/useCollectionSegment";
import { useWarmCurrentVisualizer } from "../player/visualizers/useWarmVisualizers";
import { usePluginZone } from "../plugins/sidebar/usePluginZone";
import { useFinderLaunch } from "./useFinderLaunch";

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
  useCloseCollectionFull,
  useCollectionFullAlbumId,
  useRouteCollection,
} from "../../state/collection/store";
import {
  useAppMode,
  useCurrentTrackId,
  usePlayerError,
  usePlayerStore,
  usePlayerSync,
} from "../../state/player/store";
import { useSpectrumSync } from "../../state/player/spectrum";
import { restoreResume } from "../../state/player/restoreResume";
import { useResumeWriter } from "../../state/player/useResumeWriter";
import { useLibrarySync } from "../../state/useLibrarySync";
import { usePluginsSync } from "../../state/plugins/usePluginsSync";
import { useSandboxCheck } from "../../state/plugins/sandboxStore";
import { usePluginStatusSync } from "../../state/plugins/usePluginStatus";
import { usePluginNet } from "../../state/plugins/usePluginNet";
import { usePluginPageEvents } from "../../state/plugins/usePluginPageEvents";
import { usePluginStreamEvents } from "../../state/plugins/usePluginStreamEvents";
import { usePluginEvents } from "../../state/plugins/usePluginEvents";
import { useLibraryWatch } from "../../state/plugins/useLibraryWatch";
import { usePluginUi } from "../../state/plugins/usePluginUi";
import {
  useHistoryLens,
  useOpenTool,
  usePluginPageRequest,
  useSetOpenTool,
  useSetPluginRoute,
  useSettingsRequest,
  useSetShortcutsOpen,
  useShortcutsOpen,
} from "../../state/shell/store";

// -- IPC Imports --
import { getStartupError, playerEnqueueFiles, playerPlayFiles } from "../../lib/ipc";

// -- Unit Imports --
import {
  firstVisibleDestination,
  isDestinationVisible,
  pluginIdOf,
  pluginMode,
  zoneHasPlugin,
} from "./navVisibility";
import { visibleSegments } from "../collection/collectionSegments";
import type { Mode, NavTarget } from "./navVisibility";

// -- Type Imports --
import type { PlaybackSource } from "../../types";
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
  useWarmCurrentVisualizer();
  // One listener for the app's life, following the engine's status and error events into the store.
  usePlayerSync();
  // Saves the library session for the next launch. This shell only mounts in the main window.
  useResumeWriter();
  // The live spectrum feed into its own off-render singleton, running the app's life alongside the status.
  useSpectrumSync();
  // The background library sync feeds its progress, row changes and root states in for the shell's life.
  useLibrarySync();
  // The plugin registry, read at boot and kept live by the backend's change event.
  usePluginsSync();
  // The sandbox self-check of this start, which decides whether plugins wear the unsandboxed tag.
  useSandboxCheck();
  // The supervised status of every serving plugin, for the rail dots, pages and hub lines.
  usePluginStatusSync();
  // The toasts, prompts, chips and item states plugins set, fed in for the shell's life.
  usePluginUi();
  // Stream chunks and socket messages from Rust, relayed to the plugin's page.
  usePluginNet();
  // A native plugin's page events, relayed to its open page.
  usePluginPageEvents();
  // App event topics, relayed to the frames that subscribed; library edits reported to Rust.
  usePluginEvents();
  useLibraryWatch();
  // The seated stream's events, relayed to the plugin that owns it.
  usePluginStreamEvents();
  // The working identity that shapes the sidebar nav. Read from the pref cache, so the first paint
  // already has the right rows.
  const appMode = useAppMode();
  // Standalone opens on the Player over the handed file; the full app opens on the Home landing.
  const [mode, setMode] = useState<Mode>(standalone ? "player" : "home");
  // A plugin page is open only while its plugin is still drawn in the rail.
  const pluginZone = usePluginZone();
  const pluginId = pluginIdOf(mode);
  const pluginLive = pluginId != null && zoneHasPlugin(pluginZone, pluginId);
  const setPluginRoute = useSetPluginRoute();
  const openPlugin = useCallback(
    (id: string, route: string | null) => {
      setPluginRoute(route);
      setMode(pluginMode(id));
    },
    [setPluginRoute],
  );
  const segment = useCollectionSegment();
  const routeCollection = useRouteCollection();
  const fullAlbumId = useCollectionFullAlbumId();
  const closeFull = useCloseCollectionFull();
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
  // The album full pane covers the wall only on the Albums segment; a deleted id never counts as open.
  const fullPaneShowing =
    mode === "collection" &&
    segment === "albums" &&
    fullAlbumId != null &&
    albums.some((a) => a.id === fullAlbumId);
  // The full-pane playlist, scoped like the album pane: a deleted id no longer resolves, so the pane
  // falls back to the list rather than stranding on it.
  const openPlaylist = playlists.find((p) => p.id === openPlaylistId) ?? null;
  if (openPlaylistId != null && openPlaylist == null) {
    setOpenPlaylistId(null);
  }

  // The Track Editor destination's session. Opening a tool lands on that destination and the session
  // persists across nav: the workbench stays mounted while a session holds, hidden off the destination.
  // Closing the session clears it and leaves the empty state showing on the destination.
  const openTool = useOpenTool();
  const setOpenTool = useSetOpenTool();
  const closeTool = useCallback(() => setOpenTool(null), [setOpenTool]);

  // The lens the History destination opens on. A Home See-all sets it before navigating, so History
  // seeds its own local lens from it on mount.
  const historyLens = useHistoryLens();

  // The one way into any destination. A Collection target sets its segment (and any pane) in the store,
  // which remembers it, then lands on the destination.
  const navigate = useCallback(
    (target: NavTarget) => {
      if (typeof target === "string") {
        setMode(target);
        return;
      }
      routeCollection(target);
      setMode("collection");
    },
    [routeCollection],
  );

  // Routes the Player's "playing from" link back into the library: a container opens its full pane, a flat
  // view just switches mode. A lone single carries a track id, not a container, so it has no destination.
  // The source kinds keep their own names, since the resume blob persists them.
  const onNavigate = useCallback(
    (source: PlaybackSource) => {
      switch (source.kind) {
        case "album":
          navigate({ segment: "albums", full: source.id });
          break;
        case "playlist":
          setOpenPlaylistId(source.id);
          setMode("playlists");
          break;
        case "files":
          setMode("files");
          break;
        case "tracks":
          navigate({ segment: "tracks" });
          break;
        case "singles":
          navigate({ segment: "singles" });
          break;
        case "unsorted":
          setMode("unsorted");
          break;
        case "history":
          setMode("history");
          break;
        case "single":
          break;
      }
    },
    [navigate],
  );

  // Seat the saved session paused. Only a launch with no file to open reaches the non-standalone shell,
  // so an open-with launch never restores and leaves the blob intact.
  useEffect(() => {
    if (!standalone) void restoreResume();
  }, [standalone]);

  // The organize and playlist projections hydrate once the library is up. On the normal path the gate has
  // booted before this shell mounts, so they load on bare mount. Standalone owns its own boot here, so
  // those two reads wait for it - a bare-mount read would hit an empty DB and leave Albums and Playlists
  // blank. Preferences carry theme and locale, so they load at once on both paths.
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

  // Pull only the take-once launch error: an all-unreadable batch latches it, so the refusal body shows
  // even when the batch's file notice fired before this shell subscribed. The files themselves play from
  // the backend intake buffer, not here. A batch that plays clears the region to the player.
  useEffect(() => {
    if (!standalone) return;
    void getStartupError()
      .then((notice) => {
        if (notice) setFailed(true);
      })
      .catch(() => {});
  }, [standalone]);

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

  // Latch the first track that ever holds; after it, PlayerView owns the empty state.
  useEffect(() => {
    if (trackId != null) setStarted(true);
  }, [trackId]);

  // The one-way "Open library" reveal, standalone only: an empty library lands the main region on the
  // add-a-folder onboarding, while a stocked one stays on the player for the user to navigate from the
  // now-visible sidebar. Waits for boot so a stocked library is never misread as empty mid-hydration.
  useEffect(() => {
    if (noLibrary && sidebarExpanded) navigate({ segment: "albums" });
  }, [noLibrary, sidebarExpanded, navigate]);

  // Opening a tool from a track's menu lands on the Editor destination. Clearing the session does not
  // navigate: closing a file leaves you on the destination, showing its empty state.
  useEffect(() => {
    if (openTool != null) setMode("editor");
  }, [openTool]);

  // The title bar's folder label lands on Settings. Only a request made while this shell is mounted
  // counts, so a remount never replays an old one.
  const settingsRequest = useSettingsRequest();
  const seenSettingsRequest = useRef(settingsRequest);
  useEffect(() => {
    if (settingsRequest === seenSettingsRequest.current) return;
    seenSettingsRequest.current = settingsRequest;
    setMode("settings");
  }, [settingsRequest]);

  // A plugin asking to show its own page. Only a request made while this shell is mounted counts, and
  // only for a plugin the rail draws: the app mode may hide the page, and then the ask is dropped.
  const pluginPageRequest = usePluginPageRequest();
  const seenPageRequest = useRef(pluginPageRequest?.seq ?? 0);
  useEffect(() => {
    if (!pluginPageRequest || pluginPageRequest.seq === seenPageRequest.current) return;
    seenPageRequest.current = pluginPageRequest.seq;
    if (zoneHasPlugin(pluginZone, pluginPageRequest.id)) {
      openPlugin(pluginPageRequest.id, pluginPageRequest.route);
    }
  }, [pluginPageRequest, pluginZone, openPlugin]);

  // A mode flip can hide the destination you are standing on. When it does, land on the first the new
  // mode still shows, in nav order. Settings lives in the foot and stays reachable, and an editor with a
  // live session is a file you opened, so neither is swept off. Standalone opens on its handed file and
  // owns its own landing, so it sits this out. The visibility guard keeps this from looping: once the
  // landing is a shown destination it does not fire again. A plugin page is held to the same rule: it
  // goes when its plugin is disabled, uninstalled, or hidden by the new mode.
  useEffect(() => {
    if (standalone) return;
    if (mode === "settings") return;
    if (mode === "editor" && openTool != null) return;
    if (pluginId != null) {
      if (!pluginLive) setMode(firstVisibleDestination(appMode));
      return;
    }
    if (isDestinationVisible(appMode, mode)) return;
    setMode(firstVisibleDestination(appMode));
  }, [appMode, mode, openTool, standalone, pluginId, pluginLive]);

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
        unsortedCount={unsorted.length}
        playlistsCount={playlists.length}
        coversCount={coversNeeded}
        collapsed={collapsed}
        bare={noLibrary && sidebarExpanded}
        search={finder.pill}
      />
      <main className={styles.main}>
        {mode === "home" ? (
          // Home needs a library; an empty one keeps the add-a-folder onboarding, as the walls do.
          count === 0 ? emptyLibrary : <HomeView onNavigate={navigate} />
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
            <PlayerView onNavigate={onNavigate} />
          )
        ) : mode === "settings" ? (
          <SettingsView
            onReviewGone={() => navigate({ segment: "tracks" })}
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
        ) : mode === "history" ? (
          <HistoryView initialLens={historyLens} />
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
              {mode === "collection" ? (
                <CollectionSwitch
                  visible={visibleSegments(appMode)}
                  segment={segment}
                  counts={{ albums: albums.length, singles: singles.length, tracks: count }}
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
          </>
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
        <ScanIssuesHost />
        <PluginConfirmHost />

        {/* The offer to start without plugins, shown while the runtime is held after an unclean exit. */}
        <SafeModeOffer />

        {shortcutsOpen ? <ShortcutsSheet onClose={closeShortcuts} /> : null}
      </main>
    </div>
  );
}
