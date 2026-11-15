/*
 * The main window's end of the plugin UI surfaces: toasts, prompts, page requests and live sidebar state
 * pushed by Rust. It listens first, then reads what Rust still holds, then replays what arrived during
 * the read, so an older read never overwrites a newer event. A read that keeps failing never reads as
 * empty: what the stores hold stays. The logic is `createUiSync` with every dependency injected; the
 * hook only starts it once the plugin runtime is up and keeps the stores to the live plugins.
 */

// -- Framework Imports --
import { useEffect, useRef } from "react";

// -- Library Imports --
import { listen } from "@tauri-apps/api/event";

// -- State Imports --
import { crashKey, pluginRuntimeReady } from "./frameModel";
import { usePluginPromptStore } from "./pluginPrompt";
import { closePluginToast, dropPluginToasts, pushPluginToast } from "./pluginToast";
import { useSidebarState } from "./sidebarState";
import { usePlugins, usePluginsBoot } from "./store";
import { requestPluginPage } from "../shell/store";

// -- IPC Imports --
import { pluginSidebarState, pluginUiPending } from "../../lib/ipc";

// -- Utils Imports --
import { livePlugins } from "../../components/shell/navVisibility";
import { withRetry } from "../../lib/withRetry";

// -- Type Imports --
import type {
  PluginRow,
  PluginSidebarEvent,
  PluginSidebarSnapshot,
  PluginUiEvent,
} from "../../types";

/** The event Rust emits for toasts, prompts and page requests. */
export const EVENT_UI = "plugins:ui";

/** The event Rust emits for chips and sidebar item changes. */
export const EVENT_SIDEBAR = "plugins:sidebar";

export interface UiSyncDeps {
  /** Subscribes to a Tauri event and resolves its removal. */
  listen: (name: string, handler: (event: { payload: unknown }) => void) => Promise<() => void>;
  readPending: () => Promise<PluginUiEvent[]>;
  readSidebar: () => Promise<PluginSidebarSnapshot[]>;
  /** The boot retry the reads go through. */
  retry: <T>(read: () => Promise<T>) => Promise<T>;
  /** The crash key of a live plugin, or null when the id is not live. */
  keyOf: (id: string) => string | null;
  pushToast: (event: PluginUiEvent) => void;
  pushPrompt: (event: PluginUiEvent) => void;
  /** Removes a closed request from both queues. */
  close: (requestId: string) => void;
  openPage: (id: string, route: string | null) => void;
  applySnapshot: (snapshots: PluginSidebarSnapshot[], keys: ReadonlyMap<string, string>) => void;
  applyEvent: (event: PluginSidebarEvent, key: string) => void;
}

type Arrival = { channel: "ui"; event: PluginUiEvent } | { channel: "sidebar"; event: PluginSidebarEvent };

/** Starts listening, then reads what Rust holds and replays what arrived meanwhile. Returns the teardown. */
export function createUiSync(deps: UiSyncDeps): () => void {
  let alive = true;
  let buffer: Arrival[] | null = [];
  const unlistens: (() => void)[] = [];

  const route = (arrival: Arrival) => {
    if (arrival.channel === "sidebar") {
      const key = deps.keyOf(arrival.event.id);
      if (key != null) deps.applyEvent(arrival.event, key);
      return;
    }
    const event = arrival.event;
    if (event.kind === "toast") deps.pushToast(event);
    else if (event.kind === "confirm") deps.pushPrompt(event);
    else if (event.kind === "close") deps.close(event.request_id);
    else if (event.kind === "open_page") deps.openPage(event.id, event.payload.route);
  };

  const receive = (arrival: Arrival) => {
    if (!alive) return;
    if (buffer) buffer.push(arrival);
    else route(arrival);
  };

  const subscribe = (name: string, wrap: (payload: unknown) => Arrival) =>
    withRetry(() => deps.listen(name, (event) => receive(wrap(event.payload))))
      .then((unlisten) => {
        if (alive) unlistens.push(unlisten);
        else unlisten();
      })
      .catch(() => {
        // Still rejected after every retry: there is nothing to hear.
      });

  const readPending = async () => {
    try {
      const events = await deps.retry(deps.readPending);
      if (alive) events.forEach((event) => route({ channel: "ui", event }));
    } catch {
      // Keep what is queued: a failed read is not an empty one.
    }
  };

  const readSidebar = async () => {
    try {
      const snapshots = await deps.retry(deps.readSidebar);
      if (!alive) return;
      const keys = new Map<string, string>();
      for (const snap of snapshots) {
        const key = deps.keyOf(snap.id);
        if (key != null) keys.set(snap.id, key);
      }
      deps.applySnapshot(snapshots, keys);
    } catch {
      // Keep the live state: a failed read is not an empty one.
    }
  };

  void (async () => {
    await Promise.all([
      subscribe(EVENT_UI, (payload) => ({ channel: "ui", event: payload as PluginUiEvent })),
      subscribe(EVENT_SIDEBAR, (payload) => ({ channel: "sidebar", event: payload as PluginSidebarEvent })),
    ]);
    if (!alive) return;
    await Promise.all([readPending(), readSidebar()]);
    if (!alive) return;
    const held = buffer ?? [];
    buffer = null;
    held.forEach(route);
  })();

  return () => {
    alive = false;
    buffer = null;
    unlistens.splice(0).forEach((unlisten) => unlisten());
  };
}

/** The production dependencies: Tauri events, the boot retry and the plugin UI stores. */
export function browserUiDeps(rows: () => readonly PluginRow[]): UiSyncDeps {
  return {
    listen: (name, handler) => listen(name, handler),
    readPending: pluginUiPending,
    readSidebar: pluginSidebarState,
    retry: (read) => withRetry(read),
    keyOf: (id) => {
      const row = livePlugins(rows()).find((r) => r.id === id);
      return row ? crashKey(row) : null;
    },
    pushToast: pushPluginToast,
    pushPrompt: (event) => usePluginPromptStore.getState().push(event),
    close: (requestId) => {
      closePluginToast(requestId);
      usePluginPromptStore.getState().close(requestId);
    },
    openPage: requestPluginPage,
    applySnapshot: (snapshots, keys) => useSidebarState.getState().applySnapshot(snapshots, keys),
    applyEvent: (event, key) => useSidebarState.getState().applyEvent(event, key),
  };
}

/**
 * Keeps the plugin toasts, prompts, page requests and sidebar state live. Mounted once, at the top of the
 * shell; does nothing until the plugin runtime is ready.
 */
export function usePluginUi(): void {
  const rows = usePlugins();
  const runtime = pluginRuntimeReady(usePluginsBoot());
  const rowsRef = useRef(rows);
  rowsRef.current = rows;

  useEffect(() => {
    if (!runtime) return;
    return createUiSync(browserUiDeps(() => rowsRef.current));
  }, [runtime]);

  // A plugin that stops being live loses its queued surfaces and its live state; Rust closes its side.
  useEffect(() => {
    if (!runtime) return;
    const live = livePlugins(rows);
    const ids = new Set(live.map((row) => row.id));
    dropPluginToasts(ids);
    usePluginPromptStore.getState().dropPlugins(ids);
    useSidebarState.getState().prune(new Map(live.map((row) => [row.id, crashKey(row)])));
  }, [runtime, rows]);
}
