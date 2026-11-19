/*
 * The shell's routing: the current destination, the one `navigate` every jump goes through, the
 * requests that land the shell somewhere (a tool opening, the title bar's Settings label, a plugin
 * asking for its page), and the sweep off a destination the working mode no longer shows.
 */

// -- Framework Imports --
import { useCallback, useEffect, useRef, useState } from "react";
import type { Dispatch, SetStateAction } from "react";

// -- Hook Imports --
import { usePluginZone } from "../plugins/sidebar/usePluginZone";

// -- State Imports --
import { useRouteCollection } from "../../state/collection/store";
import { useAppMode } from "../../state/player/store";
import { useRestoreGeneration } from "../../state/restorePoints/store";
import {
  useOpenTool,
  usePluginPageRequest,
  useSetOpenTool,
  useSetPluginRoute,
  useSettingsRequest,
} from "../../state/shell/store";

// -- Unit Imports --
import {
  firstVisibleDestination,
  isDestinationVisible,
  pluginIdOf,
  pluginMode,
  zoneHasPlugin,
} from "./navVisibility";
import type { Mode, NavTarget } from "./navVisibility";

// -- Type Imports --
import type { PlaybackSource } from "../../types";
import type { ToolSession } from "../../state/shell/store";

export interface ShellNavigation {
  mode: Mode;
  setMode: Dispatch<SetStateAction<Mode>>;
  navigate: (target: NavTarget) => void;
  onNavigate: (source: PlaybackSource) => void;
  openPlugin: (id: string, route: string | null) => void;
  pluginId: string | null;
  pluginLive: boolean;
  openPlaylistId: number | null;
  setOpenPlaylistId: Dispatch<SetStateAction<number | null>>;
  openTool: ToolSession | null;
  closeTool: () => void;
}

export function useShellNavigation({
  standalone,
  sidebarExpanded,
  noLibrary,
}: {
  standalone: boolean;
  sidebarExpanded: boolean;
  noLibrary: boolean;
}): ShellNavigation {
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
  const routeCollection = useRouteCollection();
  const [openPlaylistId, setOpenPlaylistId] = useState<number | null>(null);
  // A restore reassigns playlist ids, so the open playlist closes back to the list.
  const restoreGeneration = useRestoreGeneration();
  const seenGeneration = useRef(restoreGeneration);
  useEffect(() => {
    if (seenGeneration.current === restoreGeneration) return;
    seenGeneration.current = restoreGeneration;
    setOpenPlaylistId(null);
  }, [restoreGeneration]);

  // The Track Editor destination's session. Opening a tool lands on that destination and the session
  // persists across nav: the workbench stays mounted while a session holds, hidden off the destination.
  // Closing the session clears it and leaves the empty state showing on the destination.
  const openTool = useOpenTool();
  const setOpenTool = useSetOpenTool();
  const closeTool = useCallback(() => setOpenTool(null), [setOpenTool]);

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

  return {
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
  };
}
